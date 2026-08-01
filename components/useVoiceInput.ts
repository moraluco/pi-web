"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 可选语音输入（pi-voice 集成）。
 *
 * 设计原则：可选项。挂载时探测本地语音服务（/api/voice/status）——
 * 服务不存在则 available=false，界面自动隐藏麦克风按钮，不影响任何现有功能。
 * 录音 → 转 16kHz 单声道 WAV → POST /api/voice/transcribe → 回调识别文本。
 */
export interface VoiceInputApi {
  available: "checking" | boolean;
  recording: boolean;
  busy: boolean; // 转写中
  error: string | null;
  toggle: () => void;
}

export function useVoiceInput(
  onText: (text: string) => void,
  onLevel?: (level: number) => void,
): VoiceInputApi {
  const [available, setAvailable] = useState<"checking" | boolean>("checking");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  // 音量仪表（录音期间 60fps 上报 RMS 电平 0..1）
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);

  const stopLevelMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    onLevelRef.current?.(-1); // 通知前端复位动画
  }, []);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      const an = analyserRef.current;
      if (!an) return;
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      onLevelRef.current?.(Math.min(1, rms * 5));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // 挂载时探测一次
  useEffect(() => {
    let cancelled = false;
    fetch("/api/voice/status", { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { ok?: boolean }) => {
        if (!cancelled) setAvailable(Boolean(d?.ok));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      setRecording(false);
      if (blob.size < 1024) {
        setError("没听清，再试一次？");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const wav = await blobToWav16k(blob);
        const res = await fetch("/api/voice/transcribe", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wav,
          signal: AbortSignal.timeout(120_000),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; text?: string; error?: string; ready?: boolean }
          | null;
        if (!res.ok || !data?.ok) {
          throw new Error(
            data?.ready === false
              ? "语音服务模型加载中，请稍候再试"
              : data?.error || `转写失败（HTTP ${res.status}）`,
          );
        }
        if (data.text) onTextRef.current(data.text);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    } finally {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      stopLevelMeter();
    }
  }, [stopLevelMeter]);

  const toggle = useCallback(() => {
    if (busy) return;
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        startLevelMeter(stream);
        const rec = new MediaRecorder(stream);
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          void finishRecording();
        };
        rec.onerror = () => {
          stopLevelMeter();
          setError("录音失败");
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          recorderRef.current = null;
          setRecording(false);
        };
        rec.start();
        recorderRef.current = rec;
        setRecording(true);
      })
      .catch((e) => {
        setError(`无法访问麦克风：${(e as Error).message}`);
      });
  }, [busy, recording, finishRecording, startLevelMeter]);

  return { available, recording, busy, error, toggle };
}

/** MediaRecorder 输出（webm/opus 等）→ 16kHz 单声道 PCM WAV */
async function blobToWav16k(blob: Blob): Promise<Blob> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const src = buf.getChannelData(0);
    const targetRate = 16000;
    const out = new Float32Array(Math.max(1, Math.round((src.length * targetRate) / buf.sampleRate)));
    for (let i = 0; i < out.length; i++) {
      const p = (i * buf.sampleRate) / targetRate;
      const i0 = Math.floor(p);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const frac = p - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    return encodeWav(out, targetRate);
  } finally {
    void ctx.close();
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
