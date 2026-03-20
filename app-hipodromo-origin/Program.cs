var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// ✅ 1) Si existe wwwroot/index.html, esto lo sirve por defecto en "/"
app.UseDefaultFiles();

// ✅ 2) Sirve archivos estáticos: /assets/app.css, /assets/app.js, etc.
app.UseStaticFiles();

// (Opcional) endpoint para probar que el host está vivo
app.MapGet("/api/health", () => Results.Json(new { status = "ok", time = DateTime.UtcNow }));

app.Run();