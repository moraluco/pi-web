import { NextResponse } from "next/server";

/**
 * 语音会话 —— 关闭 VAD 监听。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const res = await fetch(`${VOICE_SERVICE}/api/listen/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    return NextResponse.json(data ?? { ok: false, error: `listen/stop ${res.status}` }, {
      status: res.ok ? 200 : 502,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "voice service unavailable" }, { status: 502 });
  }
}
