(() => {
  "use strict";

  // =============================
  // Debug: confirma carga
  // =============================
  console.log("[AppHipodromo] app.js cargado", new Date().toISOString());

  // =============================
  // Config
  // =============================
  const API_BASE = "https://api.andymg.com";
  const EXAMPLE_1 = "https://www.hipodromo.com.mx/desktop/images/pdf/programas/10Programa0322Completo.pdf";
  const EXAMPLE_2 = "https://www.hipodromo.com.mx/desktop/images/pdf/programas/09Programa0321Completo.pdf";

  const ALLOWED_HOSTS = new Set(["www.hipodromo.com.mx", "hipodromo.com.mx"]);
  const ALLOWED_PREFIX = "/desktop/images/pdf/programas/";
  // NNProgramaMMDDCompleto.pdf (o Completo1, Completo2...)
  const FILENAME_RE = /^\d{2}Programa(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])Completo(\d+)?\.pdf$/i;

  // =============================
  // DOM
  // =============================
  const pdfUrl = document.getElementById("pdfUrl");
  const pdfHint = document.getElementById("pdfHint");
  const pdfError = document.getElementById("pdfError");
  const venue = document.getElementById("venue");
  const profile = document.getElementById("profile");
  const budgetMin = document.getElementById("budgetMin");
  const budgetMax = document.getElementById("budgetMax");

  const btnGenerate = document.getElementById("btnGenerate");
  const btnClear = document.getElementById("btnClear");
  const btnCopy = document.getElementById("btnCopy");
  const btnRecalc = document.getElementById("btnRecalc");
  const btnExample1 = document.getElementById("btnPasteExample1");
  const btnExample2 = document.getElementById("btnPasteExample2");
  const btnExportPdf = document.getElementById("btnExportPdf");

  const panel = document.getElementById("panel");
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const toastWrap = document.getElementById("toastWrap");

  // Guard rails: si algo no existe, no seguimos (evita errores silenciosos)
  const required = [
    pdfUrl, pdfHint, pdfError, venue, profile, budgetMin, budgetMax,
    btnGenerate, btnClear, btnCopy, btnRecalc, btnExample1, btnExample2,
    panel, toastWrap
  ];
  if (required.some(x => !x)) {
    console.error("[AppHipodromo] Faltan elementos del DOM. Revisa IDs en index.html.");
    return;
  }

  // =============================
  // State
  // =============================
  let activeTab = "min";
  let lastOutput = null;
  let touched = false;
  let isBusy = false;
  let lastRenderedHtml = "";

  // =============================
  // UI Helpers
  // =============================
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(title, msg, icon = "✨") {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `
      <div class="t-icon">${escapeHtml(icon)}</div>
      <div>
        <div class="t-title">${escapeHtml(title)}</div>
        <div class="t-msg">${escapeHtml(msg)}</div>
      </div>
      <button class="t-close" type="button" aria-label="Cerrar">×</button>
    `;
    t.querySelector(".t-close").addEventListener("click", () => t.remove());
    toastWrap.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function setFieldState(ok, message = "") {
    if (ok) {
      pdfError.textContent = "";
      pdfHint.textContent = "Link válido ✅";
      pdfHint.style.color = "rgba(125,255,155,.85)";
      pdfUrl.style.borderColor = "rgba(34,197,94,.55)";
      pdfUrl.style.boxShadow = "0 0 0 4px rgba(34,197,94,.16)";
    } else {
      pdfHint.textContent = "Acepta solo links del Hipódromo (sin parámetros ni #).";
      pdfHint.style.color = "rgba(185,179,233,.85)";
      pdfUrl.style.borderColor = touched ? "rgba(236,72,153,.55)" : "rgba(255,255,255,.10)";
      pdfUrl.style.boxShadow = touched ? "0 0 0 4px rgba(236,72,153,.14)" : "none";
      pdfError.textContent = touched ? message : "";
    }
  }

  function setBusy(busy) {
    isBusy = busy;

    btnGenerate.disabled = busy || !canGenerate();
    btnClear.disabled = busy;

    btnCopy.disabled = busy || !lastOutput;
    btnRecalc.disabled = busy || !lastOutput?.plan_id;

    if (btnExportPdf) btnExportPdf.disabled = busy || !lastOutput;

    btnGenerate.textContent = busy ? "Generando…" : "Generar planes";
  }

  function setEmptyPanel() {
    panel.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✨</div>
        <div class="empty-title">Listo para generar</div>
        <div class="empty-text">Pega un PDF válido y presiona <b>Generar planes</b>.</div>
      </div>
    `;
    lastRenderedHtml = panel.innerHTML;
  }

  function formatCurrency(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "$0";
    try {
      return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(num);
    } catch {
      return "$" + num.toFixed(0);
    }
  }

  function formatDate(value) {
    if (!value) return "";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString("es-MX");
    } catch {
      return String(value);
    }
  }

  function resolveBudget() {
    const m = lastOutput?.meta ?? {};
    const r = lastOutput?.result?.received ?? {};
    const minRaw = m.budget_min ?? m.budgetMin ?? r.budget_min ?? r.budgetMin ?? Number(budgetMin.value);
    const maxRaw = m.budget_max ?? m.budgetMax ?? r.budget_max ?? r.budgetMax ?? Number(budgetMax.value);
    const min = Number(minRaw);
    const max = Number(maxRaw);
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
    };
  }

  function resolveMeta() {
    const m = lastOutput?.meta ?? {};
    const r = lastOutput?.result?.received ?? {};
    return {
      venue: m.venue ?? r.venue ?? venue.value,
      profile: m.profile ?? r.profile ?? profile.value,
      generatedAt: m.generated_at ?? m.generatedAt ?? lastOutput?.result?.generatedAt ?? null,
      pdfUrl: m.pdf_url ?? m.pdf ?? r.pdf_url ?? r.pdf ?? r.pdfUrl ?? pdfUrl.value.trim(),
      planId: lastOutput?.plan_id ?? lastOutput?.planId ?? null,
    };
  }

  // =============================
  // Validations
  // =============================
  function validateProgramUrl(raw) {
    if (!raw || !raw.trim()) {
      return { ok: false, code: "EMPTY", message: "Pega un link del programa (PDF)." };
    }

    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return { ok: false, code: "BAD_URL", message: "Eso no parece un link válido (URL)." };
    }

    if (!["https:", "http:"].includes(u.protocol)) {
      return { ok: false, code: "BAD_SCHEME", message: "Usa un link http o https." };
    }

    if (!ALLOWED_HOSTS.has(u.host)) {
      return { ok: false, code: "BAD_HOST", message: "Solo se aceptan links de hipodromo.com.mx." };
    }

    if (!u.pathname.startsWith(ALLOWED_PREFIX)) {
      return { ok: false, code: "BAD_PATH", message: "La ruta debe iniciar con /desktop/images/pdf/programas/." };
    }

    const filename = (u.pathname.split("/").pop() || "");
    if (!FILENAME_RE.test(filename)) {
      return { ok: false, code: "BAD_FILENAME", message: "Debe ser tipo NNProgramaMMDDCompleto.pdf (o Completo1, Completo2...)."};
    }

    if (u.search || u.hash) {
      return { ok: false, code: "NO_PARAMS", message: "Quita parámetros (?...) o fragmentos (#...)."};
    }

    return { ok: true, code: "OK", message: "Link válido ✅" };
  }

  function budgetsOk() {
    const mn = Number(budgetMin.value);
    const mx = Number(budgetMax.value);
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return false;
    if (mn <= 0 || mx <= 0) return false;
    if (mn > mx) return false;
    return true;
  }

  function canGenerate() {
    const v = validateProgramUrl(pdfUrl.value);
    return v.ok && budgetsOk();
  }

  function refreshGenerateEnabled() {
    const v = validateProgramUrl(pdfUrl.value);
    setFieldState(v.ok, v.message);
    btnGenerate.disabled = isBusy || !(v.ok && budgetsOk());
  }

  // =============================
  // API Helpers
  // =============================
  async function safeReadJson(res) {
    if (res.status === 204) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) return await res.json();

    const text = await res.text().catch(() => "");
    if (!text.trim()) return null;

    const snippet = text.slice(0, 220).replace(/\s+/g, " ").trim();
    throw new Error(
      "Respuesta no-JSON. Posible redirección/bloqueo intermedio." +
      (snippet ? `\n\nRespuesta: ${snippet}` : "")
    );
  }

  async function apiPost(path, body) {
    const url = `${API_BASE}${path}`;

    // ✅ NO cookies para evitar CORS estricto
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: body ? JSON.stringify(body) : null
    });

    const data = await safeReadJson(res);

    if (!res.ok) {
      if (data?.issues && Array.isArray(data.issues) && data.issues.length) {
        const first = data.issues[0];
        const pathTxt = (first.path || []).join(".");
        throw new Error(`${pathTxt ? pathTxt + ": " : ""}${first.message || "Validación fallida"}`);
      }
      throw new Error(data?.error || `Error HTTP ${res.status}`);
    }

    return data ?? {};
  }

  // =============================
  // Rendering
  // =============================
  function labelForTab(tabKey) {
    if (tabKey === "min") return "Plan mínimo";
    if (tabKey === "opt") return "Plan optimizado";
    return "Plan máximo";
  }

  function renderPlan(tabKey) {
    const meta = resolveMeta();
    const b = resolveBudget();

    const header = `
      <div class="plan-head">
        <div class="plan-head-left">
          <div class="plan-title">${escapeHtml(labelForTab(tabKey))}</div>
          <div class="plan-meta mono">
            📍 Zona: <b>${escapeHtml(meta.venue || "")}</b> &nbsp;•&nbsp;
            🎯 Perfil: <b>${escapeHtml(meta.profile || "")}</b> &nbsp;•&nbsp;
            🕒 <b>${escapeHtml(formatDate(meta.generatedAt))}</b>
          </div>
          <div class="mono">
            📄 PDF: ${escapeHtml(meta.pdfUrl || "")}
            ${meta.planId ? `&nbsp;•&nbsp; 🆔 ID: ${escapeHtml(meta.planId)}` : ""}
          </div>
        </div>

        <div class="plan-head-right">
          <!-- Requerimiento: pills presupuesto en 2 líneas -->
          <div class="pill-row">
            <span class="pill pill-strong">💰 Presupuesto mínimo: <b>${escapeHtml(formatCurrency(b.min))}</b></span>
          </div>
          <div class="pill-row">
            <span class="pill pill-strong">💰 Presupuesto máximo: <b>${escapeHtml(formatCurrency(b.max))}</b></span>
          </div>
        </div>
      </div>
    `;

    // Caso A: backend devuelve plans.min/opt/max
    const plan = lastOutput?.plans?.[tabKey];
    if (plan) {
      const totalHtml = `
        <div class="plan-total">
          <b>Total:</b> ${escapeHtml(formatCurrency(plan.budget))}
          ${plan.notes ? `<div class="muted" style="margin-top:6px">${escapeHtml(plan.notes)}</div>` : ""}
        </div>
      `;

      const bets = Array.isArray(plan.bets) ? plan.bets : [];
      const betsHtml = bets.length
        ? `<div class="plan-bets">
            ${bets.map(bet => {
              const race = escapeHtml(bet.race ?? "");
              const type = escapeHtml(bet.type ?? "");
              const amount = escapeHtml(formatCurrency(bet.amount ?? 0));
              const tag = bet.tag ? `<span class="tag">${escapeHtml(bet.tag)}</span>` : "";
              const desc = bet.desc ? `<div class="muted mono" style="margin-top:4px">${escapeHtml(bet.desc)}</div>` : "";
              return `
                <div class="bet-row">
                  <div>
                    <b>Carrera ${race}</b> • ${type} ${tag}
                    ${desc}
                  </div>
                  <div><b>${amount}</b></div>
                </div>
              `;
            }).join("")}
          </div>`
        : `<div class="muted" style="margin-top:12px">Este plan no trae apuestas aún.</div>`;

      panel.innerHTML = `<div class="plan-card print-wrap">${header}${totalHtml}${betsHtml}</div>`;
      lastRenderedHtml = panel.innerHTML;

      btnCopy.disabled = false;
      btnRecalc.disabled = !lastOutput?.plan_id;
      if (btnExportPdf) btnExportPdf.disabled = false;
      return;
    }

    // Caso B: backend actual: solo resumen
    const received = lastOutput?.result?.received ?? null;
    const generatedAt = lastOutput?.result?.generatedAt ?? null;

    if (!received) {
      setEmptyPanel();
      btnCopy.disabled = true;
      btnRecalc.disabled = true;
      if (btnExportPdf) btnExportPdf.disabled = true;
      return;
    }

    panel.innerHTML = `
      <div class="plan-card print-wrap">
        ${header}
        <div class="plan-sub">
          <div class="plan-total">
            <b>Resumen guardado.</b> (El API todavía no devuelve apuestas min/opt/max.)
          </div>
          <div class="mono muted">
            Estado: Pendiente de motor • Generado: ${escapeHtml(formatDate(generatedAt))}
          </div>
        </div>
      </div>
    `;
    lastRenderedHtml = panel.innerHTML;

    btnCopy.disabled = false;
    btnRecalc.disabled = true;
    if (btnExportPdf) btnExportPdf.disabled = false;
  }

  function buildCopyText() {
    if (!lastOutput) return "";

    // Si ya tenemos plans
    const plan = lastOutput?.plans?.[activeTab];
    if (plan) {
      const m = resolveMeta();
      const b = resolveBudget();
      const lines = [];
      lines.push(`${labelForTab(activeTab)} — Total: ${formatCurrency(plan.budget)}`);
      lines.push(`Zona: ${m.venue} | Perfil: ${m.profile}`);
      lines.push(`PDF: ${m.pdfUrl}`);
      if (m.planId) lines.push(`ID: ${m.planId}`);
      lines.push(`Presupuesto mín: ${formatCurrency(b.min)} | máx: ${formatCurrency(b.max)}`);
      lines.push("");

      for (const bet of (plan.bets || [])) {
        lines.push(`Carrera ${bet.race}: ${bet.type} — ${formatCurrency(bet.amount)}${bet.tag ? ` [${bet.tag}]` : ""}`);
      }
      return lines.join("\n");
    }

    // Fallback resumen
    const r = lastOutput?.result?.received ?? {};
    const lines = [];
    lines.push("Plan generado (resumen)");
    lines.push(`Zona: ${r.venue || ""} | Perfil: ${r.profile || ""}`);
    lines.push(`PDF: ${r.pdf_url || r.pdf || ""}`);
    lines.push(`Presupuesto: ${formatCurrency(r.budget_min)} — ${formatCurrency(r.budget_max)}`);
    return lines.join("\n");
  }

  // =============================
  // Export PDF SIN POPUP (iframe)
  // =============================
  function cloneStylesTo(docTarget) {
    const targetHead = docTarget.head;

    // base para resolver rutas relativas
    const base = docTarget.createElement("base");
    base.href = new URL("./", window.location.href).href;
    targetHead.appendChild(base);

    // Copia hojas CSS externas (absolutas)
    document.querySelectorAll('link[rel="stylesheet"]').forEach(node => {
      const href = node.getAttribute("href");
      if (!href) return;
      const abs = new URL(href, window.location.href).href;

      const l = docTarget.createElement("link");
      l.rel = "stylesheet";
      l.href = abs;
      targetHead.appendChild(l);
    });

    // Copia estilos inline
    document.querySelectorAll("style").forEach(node => {
      targetHead.appendChild(node.cloneNode(true));
    });

    // Ajustes de impresión
    const extra = docTarget.createElement("style");
    extra.textContent = `
      @page { margin: 14mm; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    `;
    targetHead.appendChild(extra);
  }

  function exportPlanToPdf() {
    if (!lastOutput) {
      toast("Nada para exportar", "Primero genera un plan.", "⚠️");
      return;
    }

    const html = lastRenderedHtml || panel.innerHTML || "";
    const title = labelForTab(activeTab);

    // iframe hidden (no popup)
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.opacity = "0";
    iframe.setAttribute("aria-hidden", "true");

    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main class="container">
    ${html}
  </main>
</body>
</html>`);
    doc.close();

    cloneStylesTo(doc);

    // espera a que el iframe pinte estilos
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        console.error(e);
        toast("Error al imprimir", "No se pudo abrir el diálogo de impresión.", "❌");
      } finally {
        // limpia
        setTimeout(() => iframe.remove(), 800);
      }
    }, 500);
  }

  // =============================
  // Events
  // =============================
  pdfUrl.addEventListener("input", refreshGenerateEnabled);
  pdfUrl.addEventListener("blur", () => { touched = true; refreshGenerateEnabled(); });
  pdfUrl.addEventListener("paste", () => { touched = true; setTimeout(refreshGenerateEnabled, 0); });

  [budgetMin, budgetMax].forEach(el => el.addEventListener("input", refreshGenerateEnabled));

  btnExample1.addEventListener("click", () => {
    pdfUrl.value = EXAMPLE_1;
    touched = true;
    refreshGenerateEnabled();
    toast("Ejemplo pegado", "Se pegó el ejemplo 1.", "📎");
  });

  btnExample2.addEventListener("click", () => {
    pdfUrl.value = EXAMPLE_2;
    touched = true;
    refreshGenerateEnabled();
    toast("Ejemplo pegado", "Se pegó el ejemplo 2.", "📎");
  });

  btnClear.addEventListener("click", () => {
    if (isBusy) return;

    pdfUrl.value = "";
    budgetMin.value = 200;
    budgetMax.value = 300;
    venue.value = "grada";
    profile.value = "SEGUIDO";

    touched = false;
    lastOutput = null;

    tabs.forEach(t => t.classList.remove("active"));
    const first = tabs.find(t => t.dataset.tab === "min") || tabs[0];
    if (first) first.classList.add("active");
    activeTab = "min";

    setEmptyPanel();
    btnCopy.disabled = true;
    btnRecalc.disabled = true;
    if (btnExportPdf) btnExportPdf.disabled = true;

    toast("Limpio", "Campos reiniciados.", "🧼");
    refreshGenerateEnabled();
  });

  btnGenerate.addEventListener("click", async () => {
    if (isBusy) return;

    const v = validateProgramUrl(pdfUrl.value);
    if (!v.ok) {
      touched = true;
      refreshGenerateEnabled();
      toast("Link inválido", v.message, "⚠️");
      return;
    }

    if (!budgetsOk()) {
      toast("Presupuesto inválido", "Revisa mínimo/máximo.", "⚠️");
      return;
    }

    const payload = {
      pdf_url: pdfUrl.value.trim(),
      venue: venue.value,
      profile: profile.value,
      budget_min: Number(budgetMin.value),
      budget_max: Number(budgetMax.value),
    };

    try {
      setBusy(true);
      const data = await apiPost("/api/plans", payload);
      lastOutput = data;
      renderPlan(activeTab);

      const pid = data?.plan_id ? ` (${data.plan_id})` : "";
      toast("Generado", `Plan listo${pid}`, "✅");
    } catch (e) {
      toast("Error", e?.message || "No se pudo generar el plan", "❌");
    } finally {
      setBusy(false);
    }
  });

  btnCopy.addEventListener("click", async () => {
    if (!lastOutput) return;
    const text = buildCopyText();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      toast("Copiado", "Listo para pegar.", "📋");
    } catch {
      window.prompt("Copia el texto:", text);
    }
  });

  btnRecalc.addEventListener("click", async () => {
    if (isBusy) return;
    if (!lastOutput?.plan_id) return;

    try {
      setBusy(true);
      const data = await apiPost(`/api/plans/${encodeURIComponent(lastOutput.plan_id)}/recalculate`, {});
      lastOutput = data;
      renderPlan(activeTab);
      toast("Recalculado", "Plan actualizado con settings actuales.", "🔁");
    } catch (e) {
      toast("Error", e?.message || "No se pudo recalcular", "❌");
    } finally {
      setBusy(false);
    }
  });

  if (btnExportPdf) {
    btnExportPdf.addEventListener("click", () => {
      if (isBusy) return;
      exportPlanToPdf();
    });
  }

  tabs.forEach(t => {
    t.addEventListener("click", () => {
      tabs.forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      activeTab = t.dataset.tab || "min";
      if (lastOutput) renderPlan(activeTab);
    });
  });

  // Init
  setEmptyPanel();
  refreshGenerateEnabled();
  btnCopy.disabled = true;
  btnRecalc.disabled = true;
  if (btnExportPdf) btnExportPdf.disabled = true;

})();