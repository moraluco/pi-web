import { NextResponse } from "next/server";

/**
 * 可选语音输入集成 —— 转写端点。
 * 接收浏览器录音的 wav 字节，转发给本地 pi-voice 语音服务，
 * 返回带标点的识别文本。语音服务不可用时返回 502，前端显示错误。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return NextResponse.json({ ok: false, error: "failed to read body" }, { status: 400 });
  }
  if (!body.byteLength) {
    return NextResponse.json({ ok: false, error: "empty audio" }, { status: 400 });
  }
  try {
    const res = await fetch(`${VOICE_SERVICE}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body,
      signal: AbortSignal.timeout(120_000), // 模型转写最长 2 分钟
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; ready?: boolean }
      | null;
    if (!res.ok || !data?.ok) {
      const status = data?.ready === false ? 503 : res.status === 503 ? 503 : 502;
      return NextResponse.json(
        data ?? { ok: false, error: `voice service returned ${res.status}` },
        { status },
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `voice service unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
