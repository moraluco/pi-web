"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 全双工实时语音对话（云端 API 方案：豆包实时语音）。
 *
 * 链路：浏览器麦克风(16kHz PCM) → WebSocket → 本地中继(ws://127.0.0.1:8766)
 *       → 豆包实时语音 API(流式 ASR+LLM+TTS 一体) → 返回音频(24kHz PCM) → 播放
 * 打断：说话即打断（豆包服务端 VAD 自动 + 本地可手动 interrupt）。
 *
 * 设计原则：可选项。本地中继未运行则 available=false，界面隐藏入口。
 */
export interface RealtimeChatApi {
  available: "checking" | boolean;
  active: boolean;
  connecting: boolean; // 建立会话中
  speaking: boolean; // AI 正在说话（有音频流）
  listening: boolean; // 用户说话中（本地能量检测提示）
  error: string | null;
  lastAsrText: string; // 最近识别的用户文本（显示用）
  lastChatText: string; // 最近 AI 回复文本（显示用）
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** pi 回复增量文本 → 豆包朗读（由 ChatWindow 驱动） */
  speak: (delta: string) => void;
  /** pi 回复结束 */
  speakEnd: () => void;
}

interface RealtimeChatOptions {
  /** 用户语音终版识别文本 → 发送给 pi 主会话（大脑） */
  onUserText?: (text: string) => void;
}

const RELAY_URL = "ws://127.0.0.1:8766";
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const FRAME_SAMPLES = 320; // 20ms @16k

export function useRealtimeChat(options?: RealtimeChatOptions): RealtimeChatApi {
  const [available, setAvailable] = useState<"checking" | boolean>("checking");
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAsrText, setLastAsrText] = useState("");
  const [lastChatText, setLastChatText] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const onUserTextRef = useRef(options?.onUserText);
  onUserTextRef.current = options?.onUserText;

  // 播放端：24kHz PCM 流缓冲
  const playCtxRef = useRef<AudioContext | null>(null);
  const playQueueRef = useRef<Float32Array<ArrayBuffer>[]>([]);
  const playTimerRef = useRef<number | null>(null);
  const pcmRemainderRef = useRef<Uint8Array>(new Uint8Array(0));

  const cleanup = useCallback(() => {
    workletRef.current?.disconnect();
    workletRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (playTimerRef.current !== null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    playQueueRef.current = [];
    pcmRemainderRef.current = new Uint8Array(0);
  }, []);

  /** 播放：PCM16 24kHz → AudioContext 流式播放 */
  const schedulePlayback = useCallback(() => {
    if (playTimerRef.current !== null) return;
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: OUTPUT_RATE });
    }
    const ctx = playCtxRef.current;
    playTimerRef.current = window.setInterval(() => {
      const chunk = playQueueRef.current.shift();
      if (!chunk || chunk.length === 0) return;
      const buf = ctx.createBuffer(1, chunk.length, OUTPUT_RATE);
      buf.copyToChannel(chunk, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      setSpeaking(true);
      src.onended = () => {
        if (playQueueRef.current.length === 0) setSpeaking(false);
      };
    }, 15);
  }, []);

  /** 接收二进制 PCM16 → Float32 入播放队列 */
  const handleIncomingPcm = useCallback(
    (data: ArrayBuffer) => {
      const bytes = new Uint8Array(data);
      // 拼接上次残留字节（PCM16 对齐 2 字节）
      const merged = new Uint8Array(pcmRemainderRef.current.length + bytes.length);
      merged.set(pcmRemainderRef.current, 0);
      merged.set(bytes, pcmRemainderRef.current.length);
      const usable = merged.length - (merged.length % 2);
      pcmRemainderRef.current = merged.slice(usable);
      const view = new DataView(merged.buffer, 0, usable);
      const floats = new Float32Array(new ArrayBuffer(usable / 2 * 4));
      for (let i = 0; i < floats.length; i++) {
        floats[i] = view.getInt16(i * 2, true) / 32768;
      }
      playQueueRef.current.push(floats);
      schedulePlayback();
    },
    [schedulePlayback],
  );

  const speak = useCallback((delta: string) => {
    if (!delta.trim()) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "speak", text: delta }));
    }
  }, []);

  const speakEnd = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "speak_end" }));
    }
  }, []);

  const stop = useCallback(async () => {
    setActive(false);
    setConnecting(false);
    setSpeaking(false);
    setListening(false);
    try {
      wsRef.current?.send(JSON.stringify({ type: "stop" }));
    } catch {
      /* ignore */
    }
    wsRef.current?.close();
    wsRef.current = null;
    cleanup();
  }, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      // 1. 连本地中继
      const ws = new WebSocket(RELAY_URL);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          handleIncomingPcm(ev.data as ArrayBuffer);
          return;
        }
        try {
          const msg = JSON.parse(ev.data) as {
            type: string;
            text?: string;
            message?: string;
            final?: boolean;
          };
          switch (msg.type) {
            case "session_started":
              setConnecting(false);
              setActive(true);
              break;
            case "asr":
              setLastAsrText(msg.text ?? "");
              if (msg.final && msg.text) {
                // 终版识别 → 发给 pi 主会话（大脑）
                onUserTextRef.current?.(msg.text);
              }
              break;
            case "chat":
              setLastChatText(msg.text ?? "");
              break;
            case "interrupt":
              // 服务端检测到用户开口 → 停止本地播放队列
              playQueueRef.current = [];
              setSpeaking(false);
              break;
            case "error":
              setError(msg.message ?? "语音服务错误");
              void stop();
              break;
            case "closed":
              void stop();
              break;
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        setError("无法连接本地语音中继（ws://127.0.0.1:8766）");
        setConnecting(false);
      };
      ws.onclose = () => {
        if (active) void stop();
      };

      // 2. 麦克风采集：16kHz PCM16 → WebSocket 上行
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      // 重采样到 16k：用 AudioBufferSourceNode 重采样离线太复杂，直接 ScriptProcessor/Worklet 采集原始 48k 再降采样
      const src = ctx.createMediaStreamSource(stream);
      const actualRate = ctx.sampleRate;
      const ratio = actualRate / INPUT_RATE;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        // 简单线性插值降采样到 16k
        const outLen = Math.floor(input.length / ratio);
        const out = new Int16Array(outLen);
        let sum = 0;
        for (let i = 0; i < outLen; i++) {
          const p = i * ratio;
          const i0 = Math.floor(p);
          const i1 = Math.min(i0 + 1, input.length - 1);
          const f = p - i0;
          const v = input[i0] * (1 - f) + input[i1] * f;
          out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
          sum += Math.abs(v);
        }
        setListening(sum / outLen > 0.01);
        ws.send(out.buffer);
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    } catch (e) {
      setError(`无法启动麦克风: ${(e as Error).message}`);
      setConnecting(false);
      void stop();
    }
  }, [active, handleIncomingPcm, stop]);

  // 探测本地中继
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(RELAY_URL);
      ws.onopen = () => {
        if (!cancelled) setAvailable(true);
        ws?.close();
      };
      ws.onerror = () => {
        if (!cancelled) setAvailable(false);
      };
    } catch {
      setAvailable(false);
    }
    const t = window.setTimeout(() => {
      if (!cancelled && available === "checking") setAvailable(false);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  return {
    available, active, connecting, speaking, listening, error,
    lastAsrText, lastChatText, start, stop, speak, speakEnd,
  };
}
