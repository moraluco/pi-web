import { NextResponse } from "next/server";

/**
 * 语音会话 —— 开启 VAD 监听（服务端麦克风常开，逐句检测）。
 * 代理到本地 pi-voice 语音服务（默认 127.0.0.1:8765）。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const res = await fetch(`${VOICE_SERVICE}/api/listen/start`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      return NextResponse.json(data ?? { ok: false, error: `listen/start ${res.status}` }, {
        status: data?.ok === false ? 200 : 502,
      });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ ok: false, error: "voice service unavailable" }, { status: 502 });
  }
}
