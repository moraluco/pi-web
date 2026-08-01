import { NextResponse } from "next/server";

/**
 * 可选语音输入集成 —— 能力探测端点。
 * 探测本地 pi-voice 语音服务（默认 http://127.0.0.1:8765，可用
 * PI_VOICE_SERVICE_URL 覆盖）。服务不可用时返回 ok:false，
 * 前端据此隐藏麦克风按钮（可选项设计，无服务不影响任何现有功能）。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const healthRes = await fetch(`${VOICE_SERVICE}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!healthRes.ok) throw new Error(`health ${healthRes.status}`);
    const health = await healthRes.json();
    let status: Record<string, unknown> | null = null;
    try {
      const s = await fetch(`${VOICE_SERVICE}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      status = s.ok ? ((await s.json()) as Record<string, unknown>) : null;
    } catch {
      // status 是增强信息，失败不致命
    }
    return NextResponse.json({ ok: true, ...health, ...(status ?? { ready: "loading" }) });
  } catch {
    return NextResponse.json({ ok: false, error: "voice service unavailable" });
  }
}
