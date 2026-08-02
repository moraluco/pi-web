import { NextResponse } from "next/server";

/**
 * 语音会话 —— 停止本地 TTS 播放（用户开口打断时调用）。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await fetch(`${VOICE_SERVICE}/api/tts/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* 服务不可用也返回 ok，打断失败不致命 */
  }
  return NextResponse.json({ ok: true });
}
