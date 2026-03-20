const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

dotenv.config();

const app = express();

// Si estás detrás de Cloudflare / reverse proxy
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";

/**
 * ============================================================
 * CORS (SOLO AQUÍ, NO EN CLOUDFLARE)
 * ============================================================
 *
 * Recomendación: NO uses credentials (cookies) si no lo necesitas.
 * Si en algún momento usas cookies/sesión: entonces credentials=true
 * y NUNCA puede ser Access-Control-Allow-Origin: * (debe ser exacto). [1](https://blogs.reliablepenguin.com/2025/10/09/make-a-single-path-public-with-cloudflare-zero-trust-while-the-rest-stays-protected)[2](https://www.answeroverflow.com/m/1282787731482738749)
 */

// .env ejemplo:
// CORS_ORIGINS=https://app.andymg.com,http://127.0.0.1:2121,http://localhost:2121
const allowedOrigins = (process.env.CORS_ORIGINS ||
  "https://app.andymg.com,http://127.0.0.1:2121,http://localhost:2121")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Si algún día necesitas cookies, pon CORS_CREDENTIALS=true en .env
const CORS_CREDENTIALS = String(process.env.CORS_CREDENTIALS || "false").toLowerCase() === "true";

const corsOptions = {
  origin: (origin, cb) => {
    // Permite requests sin Origin (curl/postman)
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);

    return cb(new Error(`CORS: Origen no permitido: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: CORS_CREDENTIALS,
  maxAge: 86400,
};

// Seguridad básica
app.use(helmet());

// CORS SIEMPRE ANTES de rutas
app.use(cors(corsOptions));

// Express 5: NO usar "*" en app.options. Usar regex /.*/
app.options(/.*/, cors(corsOptions));

/**
 * Parsers
 */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * JSON inválido → responder JSON (no HTML)
 */
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON",
      message: err.message,
    });
  }
  return next(err);
});

/**
 * Logs
 */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/**
 * Rate limit básico para /api/*
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  limit: 120, // 120 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

/**
 * ============================================================
 * ENDPOINTS
 * ============================================================
 */

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    marker: "SERVERJS-D-SITES-APP-HIPODROMO-API",
    pid: process.pid,
    cwd: process.cwd(),
    time: new Date().toISOString(),
  });
});

// Schema EXACTO del payload del frontend
const PlansSchema = z
  .object({
    pdf_url: z.string().url(),
    venue: z.enum(["grada", "restaurantes"]),
    profile: z.enum(["COBRAR_MAS", "SEGUIDO", "SEGUIDO_EMOCION"]),
    budget_min: z.coerce.number(),
    budget_max: z.coerce.number(),
  })
  .refine((d) => d.budget_min <= d.budget_max, {
    message: "budget_min no puede ser mayor que budget_max",
    path: ["budget_min"],
  });

app.post("/api/plans", async (req, res) => {
  try {
    const parsed = PlansSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    const payload = parsed.data;

    // TODO: tu lógica real aquí
    const result = {
      received: payload,
      generatedAt: new Date().toISOString(),
    };

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error("Error en /api/plans:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * 404
 */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not Found", path: req.originalUrl });
});

/**
 * Error handler final
 */
app.use((err, _req, res, _next) => {
  console.error("Error middleware:", err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

/**
 * Start
 */
app.listen(PORT, HOST, () => {
  console.log(`✅ API arriba: http://127.0.0.1:${PORT}`);
  console.log(`ℹ️  Escuchando en ${HOST}:${PORT}`);
  console.log(`ℹ️  CORS_ORIGINS: ${allowedOrigins.join(", ")}`);
  console.log(`ℹ️  CORS_CREDENTIALS: ${CORS_CREDENTIALS}`);
});

/**
 * Crash guards
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});