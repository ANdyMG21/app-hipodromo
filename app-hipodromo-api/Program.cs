using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using UglyToad.PdfPig;

// =============================================================
// App Hipódromo API — REAL v2 (PDF con texto seleccionable)
//
// Requisitos:
// 1) Instalar NuGet: UglyToad.PdfPig
//    - Visual Studio: Manage NuGet Packages -> Browse -> "UglyToad.PdfPig"
//    - o consola: dotnet add package UglyToad.PdfPig
//
// Este motor:
// - Descarga el PDF (pdf_url)
// - Extrae texto real (PdfPig)
// - Intenta parsear carreras y caballos (número, nombre, momio)
// - Genera plans.min/opt/max según presupuesto y perfil
//
// NOTA: El formato exacto del programa puede variar; el parser es tolerante
// y tiene fallback si algún dato no aparece.
// =============================================================

public class Program
{
    private record Runner(int Number, string Name, decimal? Odds);
    private record Race(int RaceNo, List<Runner> Runners);

    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // ✅ CORS para permitir llamadas desde el frontend (https://localhost:7065)
        builder.Services.AddCors(options =>
        {
            options.AddPolicy("FrontendDev", policy =>
            {
                policy.WithOrigins("https://localhost:7065", "http://localhost:7065")
                      .AllowAnyHeader()
                      .AllowAnyMethod();
            });
        });

        // HttpClient para descargar PDFs
        builder.Services.AddHttpClient("pdf")
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.All
            });

        var app = builder.Build();

        app.UseHttpsRedirection();
        app.UseCors("FrontendDev");

        app.MapGet("/api/health", () => Results.Ok(new
        {
            status = "ok",
            service = "app-hipodromo-api",
            version = "real-v2-pdfpig",
            time = DateTime.UtcNow
        }));

        app.MapMethods("/api/plans", new[] { "OPTIONS" }, () => Results.Ok());

        app.MapPost("/api/plans", async (HttpRequest request, IHttpClientFactory httpClientFactory) =>
        {
            JsonElement body;
            try
            {
                body = await JsonSerializer.DeserializeAsync<JsonElement>(request.Body);
            }
            catch
            {
                return Results.BadRequest(new { error = "Body JSON inválido" });
            }

            var pdfUrl = TryGetString(body, "pdf_url") ?? "";
            var venue = TryGetString(body, "venue") ?? "grada";
            var profile = TryGetString(body, "profile") ?? "SEGUIDO";
            var budgetMin = TryGetDecimal(body, "budget_min") ?? 200m;
            var budgetMax = TryGetDecimal(body, "budget_max") ?? 300m;

            if (string.IsNullOrWhiteSpace(pdfUrl))
                return Results.BadRequest(new { error = "pdf_url es requerido" });

            if (budgetMin <= 0 || budgetMax <= 0 || budgetMin > budgetMax)
                return Results.BadRequest(new { error = "Presupuesto inválido" });

            // 1) Descargar PDF
            byte[] pdfBytes;
            try
            {
                var client = httpClientFactory.CreateClient("pdf");
                client.Timeout = TimeSpan.FromSeconds(25);
                pdfBytes = await client.GetByteArrayAsync(pdfUrl);
            }
            catch (Exception ex)
            {
                return Results.Problem(title: "No se pudo descargar el PDF", detail: ex.Message, statusCode: 502);
            }

            // 2) Extraer texto (PdfPig)
            string text;
            try
            {
                text = ExtractTextPdfPig(pdfBytes);
            }
            catch (Exception ex)
            {
                return Results.Problem(title: "No se pudo leer texto del PDF", detail: ex.Message, statusCode: 500);
            }

            // 3) Parsear carreras y caballos
            var races = ParseRaces(text);

            // Fallback si no detectamos nada
            if (races.Count == 0)
            {
                races = BuildFallbackRaces();
            }

            // 4) Generar planes
            var plans = BuildPlans(races, budgetMin, budgetMax, profile);

            var response = new
            {
                ok = true,
                plan_id = Guid.NewGuid().ToString("N"),
                meta = new
                {
                    pdf_url = pdfUrl,
                    venue,
                    profile,
                    budget_min = budgetMin,
                    budget_max = budgetMax,
                    generated_at = DateTime.UtcNow,
                    races_detected = races.Count
                },
                plans
            };

            return Results.Ok(response);
        });

        app.Run();
    }

    // -----------------------------
    // JSON helpers
    // -----------------------------
    private static string? TryGetString(JsonElement body, string prop)
    {
        if (body.ValueKind != JsonValueKind.Object) return null;
        if (!body.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString();
    }

    private static decimal? TryGetDecimal(JsonElement body, string prop)
    {
        if (body.ValueKind != JsonValueKind.Object) return null;
        if (!body.TryGetProperty(prop, out var v)) return null;

        if (v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var d)) return d;
        if (v.ValueKind == JsonValueKind.String && decimal.TryParse(v.GetString(), out var ds)) return ds;
        return null;
    }

    // -----------------------------
    // PdfPig extraction
    // -----------------------------
    private static string ExtractTextPdfPig(byte[] pdfBytes)
    {
        using var ms = new MemoryStream(pdfBytes);
        using var doc = PdfDocument.Open(ms);
        var sb = new System.Text.StringBuilder();

        foreach (var page in doc.GetPages())
        {
            sb.AppendLine(page.Text);
            sb.AppendLine("\n---PAGE---\n");
        }

        return sb.ToString();
    }

    // -----------------------------
    // Parsing
    // -----------------------------

    // Detecta "CARRERA 1", "Carrera 1", "CARRERA: 1" etc.
    private static readonly Regex RaceHeaderRe = new Regex(
        @"\bCARRERA\s*[:#-]?\s*(\d{1,2})\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Heurística runner:
    // - número al inicio
    // - nombre (letras/espacios)
    // - momio opcional (decimal)
    // Ejemplos posibles:
    //  "3  EL RELAMPAGO   4.5"
    //  "10- LA LUNA  12"
    private static readonly Regex RunnerRe = new Regex(
        @"^\s*(\d{1,2})\s*[\-\.]?\s+([A-ZÁÉÍÓÚÑ\s']{3,})\s+(\d+(?:[\.,]\d+)?)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static List<Race> ParseRaces(string text)
    {
        var races = new List<Race>();
        if (string.IsNullOrWhiteSpace(text)) return races;

        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        int currentRace = -1;
        var currentRunners = new List<Runner>();

        void Flush()
        {
            if (currentRace > 0)
            {
                // Dedup por número
                var dedup = currentRunners
                    .GroupBy(r => r.Number)
                    .Select(g => g.OrderBy(x => x.Odds ?? 9999m).First())
                    .ToList();

                races.Add(new Race(currentRace, dedup));
            }
            currentRace = -1;
            currentRunners = new List<Runner>();
        }

        foreach (var raw in lines)
        {
            var line = raw.Trim();

            // 1) Header de carrera
            var mh = RaceHeaderRe.Match(line);
            if (mh.Success)
            {
                // flush anterior
                if (currentRace > 0) Flush();

                if (int.TryParse(mh.Groups[1].Value, out var rn))
                {
                    currentRace = rn;
                    continue;
                }
            }

            if (currentRace <= 0) continue;

            // 2) Runner
            var mr = RunnerRe.Match(line);
            if (mr.Success)
            {
                var numTxt = mr.Groups[1].Value;
                var nameTxt = mr.Groups[2].Value.Trim();
                var oddsTxt = mr.Groups[3].Value.Replace(',', '.');

                if (int.TryParse(numTxt, out var num))
                {
                    decimal? odds = null;
                    if (decimal.TryParse(oddsTxt, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var od))
                    {
                        odds = od;
                    }

                    currentRunners.Add(new Runner(num, NormalizeName(nameTxt), odds));
                }
            }
        }

        // último flush
        if (currentRace > 0) Flush();

        // Orden
        races = races.OrderBy(r => r.RaceNo).ToList();

        // Si algunas carreras quedaron sin runners, las completamos con fallback para no romper
        for (int i = 0; i < races.Count; i++)
        {
            if (races[i].Runners.Count == 0)
            {
                races[i] = new Race(races[i].RaceNo, new List<Runner>
                {
                    new(1, "CABALLO 1", 3.5m),
                    new(2, "CABALLO 2", 5.0m),
                    new(3, "CABALLO 3", 8.0m)
                });
            }
        }

        return races;
    }

    private static string NormalizeName(string s)
    {
        // Compacta espacios y convierte a Title-ish
        var compact = Regex.Replace(s, @"\s+", " ").Trim();
        return compact.ToUpperInvariant();
    }

    private static List<Race> BuildFallbackRaces()
    {
        return new List<Race>
        {
            new(1, new List<Runner>{ new(1,"CABALLO 1",3.5m), new(2,"CABALLO 2",5.2m), new(3,"CABALLO 3",8.0m)}),
            new(2, new List<Runner>{ new(2,"CABALLO 2",4.0m), new(5,"CABALLO 5",6.0m), new(7,"CABALLO 7",10.0m)}),
            new(3, new List<Runner>{ new(3,"CABALLO 3",3.8m), new(1,"CABALLO 1",4.8m), new(8,"CABALLO 8",12.0m)}),
            new(4, new List<Runner>{ new(4,"CABALLO 4",4.2m), new(6,"CABALLO 6",6.5m), new(9,"CABALLO 9",14.0m)}),
            new(5, new List<Runner>{ new(5,"CABALLO 5",3.9m), new(2,"CABALLO 2",5.9m), new(10,"CABALLO 10",15.0m)}),
            new(6, new List<Runner>{ new(6,"CABALLO 6",4.1m), new(1,"CABALLO 1",5.3m), new(4,"CABALLO 4",9.5m)}),
        };
    }

    // -----------------------------
    // Motor de planes (v2 con momios)
    // -----------------------------
    private static object BuildPlans(List<Race> races, decimal budgetMin, decimal budgetMax, string profile)
    {
        decimal optBudget = Round10((budgetMin + budgetMax) / 2m);

        var min = BuildPlan("min", races, budgetMin, profile);
        var opt = BuildPlan("opt", races, optBudget, profile);
        var max = BuildPlan("max", races, budgetMax, profile);

        return new { min, opt, max };
    }

    private static object BuildPlan(string kind, List<Race> races, decimal budget, string profile)
    {
        var bets = new List<object>();
        int n = Math.Max(1, races.Count);
        decimal perRace = budget / n;

        foreach (var race in races)
        {
            var ranked = RankRunners(race.Runners, profile);
            var p1 = ranked.ElementAtOrDefault(0);
            var p2 = ranked.ElementAtOrDefault(1);
            var p3 = ranked.ElementAtOrDefault(2);

            // Fallback por si algo raro
            p1 ??= new Runner(1, "CABALLO 1", null);
            p2 ??= new Runner(2, "CABALLO 2", null);
            p3 ??= new Runner(3, "CABALLO 3", null);

            if (kind == "min")
            {
                // Seguro: GANADOR + PLACE al favorito
                var win = Round10(perRace * 0.55m);
                var plc = Round10(perRace * 0.45m);
                bets.Add(new { race = race.RaceNo, type = "GANADOR", amount = win, tag = "Seguro", desc = $"#{p1.Number} {p1.Name}" });
                bets.Add(new { race = race.RaceNo, type = "PLACE", amount = plc, tag = "Cobrar", desc = $"#{p1.Number} {p1.Name}" });
            }
            else if (kind == "opt")
            {
                // Balance: exacta + ganador
                decimal exactaShare = profile == "COBRAR_MAS" ? 0.55m : profile == "SEGUIDO_EMOCION" ? 0.45m : 0.35m;
                decimal winShare = 1m - exactaShare;

                var exa = Round10(perRace * exactaShare);
                var win = Round10(perRace * winShare);

                bets.Add(new { race = race.RaceNo, type = "EXACTA", amount = exa, tag = "Balance", desc = $"#{p1.Number}-#{p2.Number} / #{p2.Number}-#{p1.Number}" });
                bets.Add(new { race = race.RaceNo, type = "GANADOR", amount = win, tag = "Valor", desc = $"#{p1.Number} {p1.Name}" });
            }
            else
            {
                // Máximo: trifecta + exacta + ganador
                decimal triShare = profile == "SEGUIDO_EMOCION" ? 0.60m : 0.50m;
                decimal exaShare = 0.25m;
                decimal winShare = 1m - triShare - exaShare;

                var tri = Round10(perRace * triShare);
                var exa = Round10(perRace * exaShare);
                var win = Round10(perRace * winShare);

                bets.Add(new { race = race.RaceNo, type = "TRIFECTA", amount = tri, tag = "Emoción", desc = $"#{p1.Number}-#{p2.Number}-#{p3.Number} / #{p1.Number}-#{p3.Number}-#{p2.Number}" });
                bets.Add(new { race = race.RaceNo, type = "EXACTA", amount = exa, tag = "Agresivo", desc = $"#{p1.Number}-#{p2.Number} / #{p1.Number}-#{p3.Number}" });
                bets.Add(new { race = race.RaceNo, type = "GANADOR", amount = win, tag = "Seguro", desc = $"#{p1.Number} {p1.Name}" });
            }
        }

        // Ajuste final: forzar suma == budget
        var sum = bets.Sum(GetAmount);
        if (bets.Count > 0 && sum != budget)
        {
            var delta = budget - sum;
            bets[^1] = AdjustLast(bets[^1], delta);
        }

        return new { budget, notes = $"Motor v2 ({kind}) • Perfil {profile}", bets };
    }

    private static List<Runner> RankRunners(List<Runner> runners, string profile)
    {
        // Ranking base: menor momio = favorito.
        // Ajuste por perfil:
        // - SEGUIDO: prioriza favoritos.
        // - COBRAR_MAS: busca valor (momio medio, no tan favorito).
        // - SEGUIDO_EMOCION: mezcla y mete un longshot como 3er pick.

        var withOdds = runners
            .Select(r => new { r, odds = r.Odds ?? 9999m })
            .OrderBy(x => x.odds)
            .Select(x => x.r)
            .ToList();

        if (profile == "COBRAR_MAS")
        {
            // Valor: 1er pick favorito, 2do pick momio medio, 3er pick siguiente
            var favorite = withOdds.FirstOrDefault();
            var mid = withOdds.Skip(Math.Min(2, Math.Max(0, withOdds.Count/2 - 1))).FirstOrDefault();
            var third = withOdds.Skip(1).FirstOrDefault();
            return new[] { favorite, mid, third }.Where(x => x != null).Distinct().Cast<Runner>().ToList();
        }

        if (profile == "SEGUIDO_EMOCION")
        {
            // Emoción: 1 y 2 favoritos, 3er pick un longshot si existe
            var favorite = withOdds.ElementAtOrDefault(0);
            var second = withOdds.ElementAtOrDefault(1);
            var longshot = withOdds.LastOrDefault();
            return new[] { favorite, second, longshot }.Where(x => x != null).Distinct().Cast<Runner>().ToList();
        }

        // Default SEGUIDO: top 3 favoritos
        return withOdds.Take(3).ToList();
    }

    private static decimal Round10(decimal v) => Math.Round(v / 10m, MidpointRounding.AwayFromZero) * 10m;

    private static decimal GetAmount(object bet)
    {
        var p = bet.GetType().GetProperty("amount");
        var v = p?.GetValue(bet);
        return v == null ? 0m : Convert.ToDecimal(v);
    }

    private static object AdjustLast(object bet, decimal delta)
    {
        int race = Convert.ToInt32(bet.GetType().GetProperty("race")?.GetValue(bet) ?? 0);
        string type = bet.GetType().GetProperty("type")?.GetValue(bet)?.ToString() ?? "";
        string tag = bet.GetType().GetProperty("tag")?.GetValue(bet)?.ToString() ?? "";
        string desc = bet.GetType().GetProperty("desc")?.GetValue(bet)?.ToString() ?? "";
        decimal amount = GetAmount(bet) + delta;
        return new { race, type, amount, tag, desc };
    }

}