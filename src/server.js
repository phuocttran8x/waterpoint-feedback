const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const {
    PORT = 4000,
        NODE_ENV = "development",
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        ADMIN_PASSWORD_HASH,
        ADMIN_PASSWORD,
        ADMIN_JWT_SECRET,
        CORS_ALLOWED_ORIGINS = "",
} = process.env;

const isProduction = NODE_ENV === "production";
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (isProduction && !hasSupabase) {
    throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production mode."
    );
}

if (isProduction && !ADMIN_PASSWORD_HASH) {
    throw new Error("ADMIN_PASSWORD_HASH is required in production mode.");
}

if (!ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD) {
    throw new Error(
        "Missing ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD for development) in environment variables."
    );
}

const effectiveAdminPasswordHash =
    ADMIN_PASSWORD_HASH || bcrypt.hashSync(String(ADMIN_PASSWORD), 10);
const effectiveAdminJwtSecret =
    ADMIN_JWT_SECRET || (isProduction ? "" : "dev-only-jwt-secret-change-me");

if (!effectiveAdminJwtSecret) {
    throw new Error("Missing ADMIN_JWT_SECRET in environment variables.");
}

if (isProduction && effectiveAdminJwtSecret.length < 32) {
    throw new Error("ADMIN_JWT_SECRET must be at least 32 characters in production mode.");
}

const supabase = hasSupabase ?
    createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) :
    null;

let inMemorySeq = 0;
let inMemoryFeedbacks = [];

function nextInMemoryId() {
    inMemorySeq += 1;
    return `WP-${String(inMemorySeq).padStart(6, "0")}`;
}

function nowIso() {
    return new Date().toISOString();
}

function normalizeValue(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeUnits(units) {
    const unique = new Set();
    for (const item of units) {
        const unit = String(item || "").trim();
        if (!unit) {
            continue;
        }
        unique.add(unit);
    }
    return Array.from(unique);
}

function validateFeedbackInput(body) {
    const errors = [];

    const name = String(body.name || "").trim();
    const content = String(body.content || "").trim();
    const unitsInput = Array.isArray(body.units) ? body.units : [];
    const units = normalizeUnits(unitsInput);

    if (name.length < 2 || name.length > 120) {
        errors.push("name must be between 2 and 120 characters");
    }

    if (!Array.isArray(body.units)) {
        errors.push("units must be an array of unit codes");
    }

    if (units.length === 0 || units.length > 30) {
        errors.push("units must contain between 1 and 30 unit codes");
    }

    if (units.some((unit) => unit.length > 40)) {
        errors.push("unit code must not exceed 40 characters");
    }

    if (content.length < 1 || content.length > 5000) {
        errors.push("content must be between 1 and 5000 characters");
    }

    return {
        errors,
        payload: {
            name,
            units,
            content,
        },
    };
}

function mapPublicFeedback(row) {
    return {
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapInternalFeedback(row) {
    return {
        id: row.id,
        name: row.name,
        units: row.units,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function participantKey(name, units) {
    const normalizedUnits = [...(units || [])]
        .map((unit) => normalizeValue(unit))
        .filter(Boolean)
        .sort();

    return `${normalizeValue(name)}|${normalizedUnits.join(",")}`;
}

function computeUniqueParticipants(records) {
    const keys = new Set(records.map((item) => participantKey(item.name, item.units)));
    return keys.size;
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

const allowedOrigins = CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin(origin, callback) {
        if (!origin) {
            return callback(null, true);
        }
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("CORS origin denied"));
    },
};

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    message: { error: "Too many login attempts. Try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use("/api", apiLimiter);

function buildPublicQuery(search) {
    let query = supabase
        .from("feedbacks")
        .select("id, content, created_at, updated_at", { count: "exact" })
        .order("updated_at", { ascending: false });

    if (search) {
        query = query.ilike("content", `%${search}%`);
    }

    return query;
}

function buildParticipantQuery(search) {
    let query = supabase.from("feedbacks").select("name, units");
    if (search) {
        query = query.ilike("content", `%${search}%`);
    }
    return query;
}

function inMemoryMatchesSearch(item, search) {
    if (!search) {
        return true;
    }
    return normalizeValue(item.content).includes(normalizeValue(search));
}

function hasOwnershipMatch(existing, ownerName, ownerUnits) {
    const submittedUnitSet = new Set(ownerUnits.map((unit) => normalizeValue(unit)));
    const hasMatchingUnit = (existing.units || []).some((unit) =>
        submittedUnitSet.has(normalizeValue(unit))
    );
    const hasMatchingName = normalizeValue(existing.name) === normalizeValue(ownerName);
    return hasMatchingName && hasMatchingUnit;
}

async function createFeedbackRecord(payload) {
    if (hasSupabase) {
        const { data, error } = await supabase
            .from("feedbacks")
            .insert({
                name: payload.name,
                units: payload.units,
                content: payload.content,
            })
            .select("id, content, created_at, updated_at")
            .single();

        if (error) {
            throw error;
        }

        return data;
    }

    const timestamp = nowIso();
    const row = {
        id: nextInMemoryId(),
        name: payload.name,
        units: payload.units,
        content: payload.content,
        created_at: timestamp,
        updated_at: timestamp,
    };

    inMemoryFeedbacks.unshift(row);
    return row;
}

async function listPublicFeedback(search, from, to) {
    if (hasSupabase) {
        const { data, count, error } = await buildPublicQuery(search).range(from, to);
        if (error) {
            throw error;
        }
        return { items: data || [], totalItems: count || 0 };
    }

    const filtered = inMemoryFeedbacks
        .filter((item) => inMemoryMatchesSearch(item, search))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

    return {
        items: filtered.slice(from, to + 1),
        totalItems: filtered.length,
    };
}

async function listParticipantRows(search) {
    if (hasSupabase) {
        const { data, error } = await buildParticipantQuery(search);
        if (error) {
            throw error;
        }
        return data || [];
    }

    return inMemoryFeedbacks
        .filter((item) => inMemoryMatchesSearch(item, search))
        .map((item) => ({ name: item.name, units: item.units }));
}

async function findFeedbackForOwnership(feedbackId) {
    if (hasSupabase) {
        const { data, error } = await supabase
            .from("feedbacks")
            .select("id, name, units")
            .eq("id", feedbackId)
            .maybeSingle();

        if (error) {
            throw error;
        }

        return data || null;
    }

    const found = inMemoryFeedbacks.find((item) => item.id === feedbackId);
    if (!found) {
        return null;
    }

    return { id: found.id, name: found.name, units: found.units };
}

async function listOwnedFeedbackByOwner(ownerName, ownerUnits) {
    if (hasSupabase) {
        const { data, error } = await supabase
            .from("feedbacks")
            .select("id, name, units, content, created_at, updated_at")
            .overlaps("units", ownerUnits)
            .order("updated_at", { ascending: false });

        if (error) {
            throw error;
        }

        return (data || []).filter((row) => hasOwnershipMatch(row, ownerName, ownerUnits));
    }

    return inMemoryFeedbacks
        .filter((row) => hasOwnershipMatch(row, ownerName, ownerUnits))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

async function updateFeedbackContent(feedbackId, content) {
    if (hasSupabase) {
        const { data, error } = await supabase
            .from("feedbacks")
            .update({
                content,
                updated_at: nowIso(),
            })
            .eq("id", feedbackId)
            .select("id, content, created_at, updated_at")
            .single();

        if (error) {
            throw error;
        }

        return data;
    }

    const target = inMemoryFeedbacks.find((item) => item.id === feedbackId);
    if (!target) {
        return null;
    }

    target.content = content;
    target.updated_at = nowIso();

    return {
        id: target.id,
        content: target.content,
        created_at: target.created_at,
        updated_at: target.updated_at,
    };
}

async function listInternalRows() {
    if (hasSupabase) {
        const { data, error } = await supabase
            .from("feedbacks")
            .select("id, name, units, content, created_at, updated_at")
            .order("created_at", { ascending: false });

        if (error) {
            throw error;
        }

        return data || [];
    }

    return [...inMemoryFeedbacks].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    );
}

function requireAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "Missing admin token" });
    }

    try {
        const payload = jwt.verify(token, effectiveAdminJwtSecret, {
            algorithms: ["HS256"],
            issuer: "waterpoint-feedback-api",
            audience: "waterpoint-admin",
        });
        if (payload.role !== "admin") {
            return res.status(403).json({ error: "Admin role required" });
        }
        req.admin = payload;
        return next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid or expired admin token" });
    }
}

function adminNoCache(_req, res, next) {
    res.setHeader("Cache-Control", "no-store");
    return next();
}

function formatDateForExport(iso) {
    if (!iso) {
        return "-";
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return String(iso);
    }
    return d.toLocaleString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function pickUnicodeFontPath() {
    const windowsDir = process.env.WINDIR || "C:\\Windows";
    const candidates = [
        path.join(windowsDir, "Fonts", "segoeui.ttf"),
        path.join(windowsDir, "Fonts", "arial.ttf"),
        path.join(windowsDir, "Fonts", "tahoma.ttf"),
    ];
    return candidates.find((fontPath) => fs.existsSync(fontPath)) || null;
}

app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: hasSupabase ? "supabase" : "in-memory" });
});

app.post("/api/feedback", async(req, res, next) => {
    try {
        const { errors, payload } = validateFeedbackInput(req.body);
        if (errors.length > 0) {
            return res.status(400).json({ errors });
        }

        const createdRow = await createFeedbackRecord(payload);

        return res.status(201).json({
            feedback: mapPublicFeedback(createdRow),
        });
    } catch (error) {
        return next(error);
    }
});

app.get("/api/feedback", async(req, res, next) => {
    try {
        const page = clampInt(req.query.page, 1, 1, 100000);
        const pageSize = clampInt(req.query.pageSize, 10, 1, 100);
        const search = String(req.query.search || "").trim().slice(0, 200);

        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;

        const { items, totalItems } = await listPublicFeedback(search, from, to);
        const participantsRows = await listParticipantRows(search);

        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

        return res.json({
            items: items.map(mapPublicFeedback),
            pagination: {
                page,
                pageSize,
                totalItems,
                totalPages,
            },
            stats: {
                uniqueParticipants: computeUniqueParticipants(participantsRows),
            },
        });
    } catch (error) {
        return next(error);
    }
});

app.post("/api/feedback/owned", async(req, res, next) => {
    try {
        const ownerName = String(req.body.name || "").trim();
        const ownerUnits = Array.isArray(req.body.units) ? normalizeUnits(req.body.units) : [];

        const errors = [];
        if (!ownerName) {
            errors.push("name is required for ownership validation");
        }
        if (ownerUnits.length === 0) {
            errors.push("units must contain at least one unit for ownership validation");
        }
        if (errors.length > 0) {
            return res.status(400).json({ errors });
        }

        const ownedRows = await listOwnedFeedbackByOwner(ownerName, ownerUnits);
        return res.json({
            items: ownedRows.map(mapPublicFeedback),
            totalItems: ownedRows.length,
        });
    } catch (error) {
        return next(error);
    }
});

app.put("/api/feedback/:id", async(req, res, next) => {
    try {
        const feedbackId = String(req.params.id || "").trim();
        const ownerName = String(req.body.name || "").trim();
        const ownerUnits = Array.isArray(req.body.units) ? normalizeUnits(req.body.units) : [];
        const content = String(req.body.content || "").trim();

        const errors = [];
        if (!feedbackId) {
            errors.push("id is required");
        }
        if (!ownerName) {
            errors.push("name is required for ownership validation");
        }
        if (ownerUnits.length === 0) {
            errors.push("units must contain at least one unit for ownership validation");
        }
        if (content.length < 1 || content.length > 5000) {
            errors.push("content must be between 1 and 5000 characters");
        }
        if (errors.length > 0) {
            return res.status(400).json({ errors });
        }

        const existing = await findFeedbackForOwnership(feedbackId);

        if (!existing) {
            return res.status(404).json({ error: "Feedback not found" });
        }

        if (!hasOwnershipMatch(existing, ownerName, ownerUnits)) {
            return res.status(403).json({ error: "Ownership validation failed" });
        }

        const updated = await updateFeedbackContent(feedbackId, content);
        if (!updated) {
            return res.status(404).json({ error: "Feedback not found" });
        }

        return res.json({ feedback: mapPublicFeedback(updated) });
    } catch (error) {
        return next(error);
    }
});

app.post("/api/admin/login", adminLoginLimiter, async(req, res, next) => {
    try {
        const password = String(req.body.password || "");
        if (!password) {
            return res.status(400).json({ error: "password is required" });
        }

        const ok = await bcrypt.compare(password, effectiveAdminPasswordHash);
        if (!ok) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign({ role: "admin" }, effectiveAdminJwtSecret, {
            expiresIn: "8h",
            issuer: "waterpoint-feedback-api",
            audience: "waterpoint-admin",
            subject: "admin",
            algorithm: "HS256",
        });
        return res.json({ token });
    } catch (error) {
        return next(error);
    }
});

app.get("/api/admin/export/anonymized", requireAdminAuth, adminNoCache, async(_req, res, next) => {
    try {
        const internalRows = await listInternalRows();

        return res.json({
            exportedAt: nowIso(),
            totalFeedbacks: internalRows.length,
            uniqueParticipants: computeUniqueParticipants(internalRows),
            feedbacks: internalRows.map((row) => ({
                id: row.id,
                content: row.content,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            })),
        });
    } catch (error) {
        return next(error);
    }
});

app.get("/api/admin/export/full", requireAdminAuth, adminNoCache, async(_req, res, next) => {
    try {
        const rows = await listInternalRows();

        return res.json({
            exportedAt: nowIso(),
            totalFeedbacks: rows.length,
            uniqueParticipants: computeUniqueParticipants(rows),
            feedbacks: rows.map(mapInternalFeedback),
        });
    } catch (error) {
        return next(error);
    }
});

app.get("/api/admin/export/report.pdf", requireAdminAuth, adminNoCache, async(_req, res, next) => {
    try {
        const rows = await listInternalRows();
        const exportedAt = nowIso();
        const fileTs = new Date().toISOString().replace(/[:.]/g, "-");
        const fontPath = pickUnicodeFontPath();

        if (!fontPath) {
            return res.status(500).json({
                error: "Khong tim thay font Unicode tren may chu de xuat PDF tieng Viet co dau.",
            });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="waterpoint-full-feedback-${fileTs}.pdf"`
        );

        const doc = new PDFDocument({
            margin: 40,
            size: "A4",
            bufferPages: true,
        });
        doc.pipe(res);

        doc.font(fontPath);

        doc.fontSize(16).text("BÁO CÁO TỔNG HỢP PHẢN ÁNH CƯ DÂN", { align: "left" });
        doc.moveDown(0.2);
        doc.fontSize(10).text(`Xuất lúc: ${formatDateForExport(exportedAt)}`);
        doc.text(`Tổng số ý kiến: ${rows.length}`);
        doc.moveDown(0.8);

        if (rows.length === 0) {
            doc.fontSize(11).text("Chưa có dữ liệu phản ánh.");
        } else {
            rows.forEach((row, idx) => {
                if (idx > 0) {
                    doc.moveDown(0.5);
                }

                doc.fontSize(12).text(`${idx + 1}. Mã: ${row.id || "-"}`);
                doc.fontSize(10).text(`Họ tên: ${row.name || "-"}`);
                doc.text(`Mã căn hộ: ${Array.isArray(row.units) && row.units.length ? row.units.join(", ") : "-"}`);
                doc.text(`Ngày gửi: ${formatDateForExport(row.created_at)}`);
                doc.text(`Cập nhật: ${formatDateForExport(row.updated_at)}`);
                doc.moveDown(0.2);
                doc.fontSize(10).text("Nội dung phản ánh:");
                doc.fontSize(10).text(String(row.content || "-"), {
                    align: "left",
                    lineGap: 2,
                });

                if (idx < rows.length - 1) {
                    doc.moveDown(0.3);
                    doc.strokeColor("#d1d5db").moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
                    doc.fillColor("black");
                }
            });
        }

        doc.end();
    } catch (error) {
        return next(error);
    }
});

app.get("/api/admin/export/report", requireAdminAuth, adminNoCache, async(_req, res, next) => {
            try {
                const rows = await listInternalRows();
                const totalFeedbacks = rows.length;
                const totalParticipants = computeUniqueParticipants(rows);
                const totalUniqueUnits = new Set(rows.flatMap(r => (r.units || []).map(u => String(u).trim().toLowerCase()))).size;
                const totalUpdated = rows.filter(r => {
                    const u = new Date(r.updated_at);
                    const c = new Date(r.created_at);
                    return Math.abs(u - c) > 60000;
                }).length;
                const exportedAt = nowIso();

                function esc(v) {
                    return String(v || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
                }

                function fmtDate(iso) {
                    if (!iso) return "—";
                    const d = new Date(iso);
                    return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
                }

                const feedbackRows = rows.map((row, idx) => `
            <tr class="item-row">
                <td class="num">${idx + 1}</td>
                <td><span class="tag tag-id">${esc(row.id)}</span></td>
                <td class="name-cell">${esc(row.name)}</td>
                <td>${(row.units || []).map(u => `<span class="tag tag-unit">${esc(u)}</span>`).join(" ")}</td>
                <td class="content-cell">${esc(row.content).replace(/\n/g, "<br>")}</td>
                <td class="date-cell">${fmtDate(row.created_at)}</td>
                <td class="date-cell">${fmtDate(row.updated_at)}</td>
            </tr>`).join("");

        const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bao cao Gop y Cu dan Waterpoint</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; background: #f1f5f9; color: #1e293b; font-size: 14px; }
  .page { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  .report-header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: #fff; border-radius: 16px; padding: 36px 40px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .report-header .brand { display: flex; align-items: center; gap: 14px; }
  .report-header .logo { width: 52px; height: 52px; background: #22d3ee; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 26px; flex-shrink: 0; }
  .report-header h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; color: #e2e8f0; }
  .report-header .sub { color: #94a3b8; font-size: 13px; }
  .report-meta { text-align: right; font-size: 13px; color: #94a3b8; line-height: 1.9; }
  .report-meta strong { color: #e2e8f0; }
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
  .stat-card { background: #fff; border-radius: 14px; padding: 20px 24px; border-left: 5px solid; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
  .stat-card.blue { border-color: #3b82f6; }
  .stat-card.green { border-color: #22c55e; }
  .stat-card.orange { border-color: #f97316; }
  .stat-card.purple { border-color: #8b5cf6; }
  .stat-card .val { font-size: 32px; font-weight: 700; line-height: 1; margin-bottom: 6px; }
  .stat-card.blue .val { color: #3b82f6; }
  .stat-card.green .val { color: #22c55e; }
  .stat-card.orange .val { color: #f97316; }
  .stat-card.purple .val { color: #8b5cf6; }
  .stat-card .lbl { font-size: 13px; color: #64748b; font-weight: 500; }
  .stat-card .note { font-size: 11px; color: #94a3b8; margin-top: 4px; }
  .notice { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 12px; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; color: #92400e; display: flex; gap: 10px; align-items: center; }
  .section-title { font-size: 18px; font-weight: 700; color: #0f172a; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
  .section-title::before { content: ""; display: inline-block; width: 4px; height: 22px; background: #3b82f6; border-radius: 4px; }
  .table-wrap { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); overflow: hidden; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #0f172a; color: #e2e8f0; }
  thead th { padding: 14px 16px; text-align: left; font-size: 12px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; white-space: nowrap; }
  .item-row { border-bottom: 1px solid #f1f5f9; }
  .item-row:last-child { border-bottom: none; }
  .item-row:nth-child(even) { background: #f8fafc; }
  .item-row:hover { background: #eff6ff; }
  td { padding: 14px 16px; vertical-align: top; font-size: 13px; color: #334155; }
  td.num { color: #94a3b8; font-weight: 600; font-size: 12px; text-align: center; width: 42px; }
  td.name-cell { font-weight: 600; color: #0f172a; white-space: nowrap; }
  td.content-cell { line-height: 1.75; color: #334155; max-width: 420px; }
  td.date-cell { white-space: nowrap; font-size: 12px; color: #64748b; }
  .tag { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; margin: 2px 2px 2px 0; }
  .tag-id { background: #1e40af; color: #bfdbfe; }
  .tag-unit { background: #064e3b; color: #6ee7b7; }
  .report-footer { text-align: center; color: #94a3b8; font-size: 12px; padding: 24px 0 8px; border-top: 1px solid #e2e8f0; margin-top: 16px; }
  .report-footer a { color: #3b82f6; text-decoration: none; }
  .github-block { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 14px; padding: 20px 24px; margin-bottom: 24px; }
  .github-block-inner { display: flex; gap: 16px; align-items: flex-start; }
  .github-icon { font-size: 28px; flex-shrink: 0; margin-top: 2px; }
  .github-title { font-size: 15px; font-weight: 700; color: #1e40af; margin-bottom: 6px; }
  .github-sub { font-size: 13px; color: #3b4f6b; line-height: 1.6; margin-bottom: 10px; }
  .github-link { display: inline-block; background: #1e40af; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none; word-break: break-all; }
  .github-link:hover { background: #1e3a8a; }
  @media print { .github-block { background: #f0f7ff; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .github-link { color: #1e40af; background: transparent; padding: 0; font-weight: 700; } }
  .print-btn { position: fixed; bottom: 28px; right: 28px; background: #3b82f6; color: #fff; border: none; padding: 14px 22px; border-radius: 14px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 20px rgba(59,130,246,.4); z-index: 99; }
  .print-btn:hover { background: #2563eb; }
  @media print {
    body { background: #fff; font-size: 12px; }
    .page { padding: 12px; max-width: 100%; }
    .print-btn { display: none; }
    .report-header { border-radius: 0; }
    .table-wrap { box-shadow: none; border: 1px solid #e2e8f0; }
    .item-row:hover { background: transparent; }
    thead tr { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .stat-card { border-left-width: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media (max-width: 900px) { .stats-row { grid-template-columns: repeat(2, 1fr); } td.content-cell { max-width: 240px; } }
</style>
</head>
<body>
<div class="page">

  <header class="report-header">
    <div class="brand">
      <div class="logo">&#127963;</div>
      <div>
        <h1>Bao cao Gop y Cu dan</h1>
        <div class="sub">Waterpoint Resident Feedback Report &#8212; Noi bo</div>
      </div>
    </div>
    <div class="report-meta">
      <div><strong>Xuat luc:</strong> ${fmtDate(exportedAt)}</div>
      <div><strong>Du lieu:</strong> Day du (co danh tinh)</div>
      <div><strong>Phan loai:</strong> Tai lieu noi bo</div>
    </div>
  </header>

  <div class="stats-row">
    <div class="stat-card blue">
      <div class="val">${totalFeedbacks}</div>
      <div class="lbl">Tong gop y</div>
    </div>
    <div class="stat-card green">
      <div class="val">${totalParticipants}</div>
      <div class="lbl">Nguoi tham gia</div>
      <div class="note">Tinh theo ten + to hop ma can</div>
    </div>
    <div class="stat-card orange">
      <div class="val">${totalUniqueUnits}</div>
      <div class="lbl">Can ho tham gia</div>
      <div class="note">Moi ma can = 1 can ho</div>
    </div>
    <div class="stat-card purple">
      <div class="val">${totalUpdated}</div>
      <div class="lbl">Da chinh sua</div>
      <div class="note">Sau lan gui dau tien</div>
    </div>
  </div>

  <div class="notice">&#9888;&#65039; <span><strong>Tai lieu noi bo mat</strong> &#8212; Chua thong tin ca nhan cu dan. Khong phan phoi ra ngoai.</span></div>

  <div class="github-block">
    <div class="github-block-inner">
      <div class="github-icon">&#128279;</div>
      <div>
        <div class="github-title">Theo doi tien trinh &amp; yeu cau bao cao thu chi</div>
        <div class="github-sub">Cu dan co the mo lien ket sau de theo doi qua trinh lam viec va yeu cau Chu dau tu / Ban quan ly cung cap bao cao thu chi minh bach:</div>
        <a class="github-link" href="https://phuocttran8x.github.io/wtp/" target="_blank" rel="noopener noreferrer">https://phuocttran8x.github.io/wtp/</a>
      </div>
    </div>
  </div>

  <div class="section-title">Danh sach gop y day du</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Ma gop y</th>
          <th>Ho va ten</th>
          <th>Ma can ho</th>
          <th>Noi dung gop y</th>
          <th>Ngay gui</th>
          <th>Cap nhat</th>
        </tr>
      </thead>
      <tbody>${feedbackRows || `<tr><td colspan="7" style="text-align:center;padding:40px;color:#94a3b8">Chua co du lieu gop y.</td></tr>`}</tbody>
    </table>
  </div>

  <footer class="report-footer">
    Bao cao duoc tao tu dong boi he thong Waterpoint Resident Feedback &nbsp;&middot;&nbsp; ${fmtDate(exportedAt)}
  </footer>
</div>
<button class="print-btn" onclick="window.print()">In bao cao</button>
</body>
</html>`;

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
    } catch (error) {
        return next(error);
    }
});

app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({
        error: "Internal server error",
    });
});

app.listen(PORT, () => {
    console.log(
        `Feedback API running on port ${PORT} (${hasSupabase ? "supabase" : "in-memory"} mode)`
    );
});