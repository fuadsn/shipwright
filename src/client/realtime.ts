import type { TaskRun } from "../shared/task";

export interface RealtimeHandlers {
  getTask: () => TaskRun | null;
  onStatus: (status: "connecting" | "listening" | "speaking" | "error" | "ready" | "recording", message?: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  onActivity: (message: string) => void;
  onTranscript: (text: string) => void;
}

export interface RealtimeConnection {
  disconnect: () => void;
  startPushToTalk: () => void;
  stopPushToTalk: () => void;
  sendToolOutput: (callId: string, output: unknown) => void;
}

export async function connectRealtime(handlers: RealtimeHandlers): Promise<RealtimeConnection> {
  handlers.onStatus("connecting", "Connecting voice session");

  const pc = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.style.display = "none";
  document.body.appendChild(audio);
  let responseActive = false;
  let recordingActive = false;

  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    void audio.play().catch(() => undefined);
    handlers.onStatus("speaking", "Murphy speaking");
  };

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioTrack = micStream.getAudioTracks()[0];
  audioTrack.enabled = false;
  pc.addTrack(audioTrack, micStream);

  const dc = pc.createDataChannel("oai-events");

  const send = (event: unknown) => {
    if (dc.readyState === "open") {
      dc.send(JSON.stringify(event));
    }
  };

  dc.addEventListener("open", () => {
    send({
      type: "session.update",
      session: {
        audio: {
          input: {
            turn_detection: null
          }
        }
      }
    });
    handlers.onStatus("ready", "Hold Space to talk");
    handlers.onActivity("Voice connected. Push-to-talk is ready.");
  });

  dc.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "response.audio.delta") {
      responseActive = true;
      void audio.play().catch(() => undefined);
      handlers.onStatus("speaking", "Murphy speaking");
    }

    if (payload.type === "response.audio.done" || payload.type === "response.done") {
      responseActive = false;
      handlers.onStatus("ready", "Hold Space to talk");
    }

    if (payload.type === "input_audio_buffer.speech_started") {
      handlers.onStatus("recording", "Recording");
    }

    if (payload.type === "input_audio_buffer.speech_stopped") {
      handlers.onStatus("ready", "Processing speech");
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed" && payload.transcript) {
      handlers.onActivity(`Transcript received: "${payload.transcript}"`);
      handlers.onTranscript(payload.transcript);
    }

    if (payload.type === "response.function_call_arguments.done") {
      responseActive = true;
      const args = payload.arguments ? JSON.parse(payload.arguments) : {};
      handlers.onActivity(`Murphy called ${payload.name}.`);
      try {
        const output = await handlers.onToolCall(payload.name, args, payload.call_id);
        handlers.onActivity(`${payload.name} completed.`);
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: payload.call_id,
            output: JSON.stringify(output)
          }
        });
        send({ type: "response.create" });
      } catch (error) {
        handlers.onActivity(`${payload.name} failed.`);
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: payload.call_id,
            output: JSON.stringify({
              error: error instanceof Error ? error.message : String(error)
            })
          }
        });
        send({ type: "response.create" });
      }
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch("/api/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  await pc.setRemoteDescription({
    type: "answer",
    sdp: await response.text()
  });

  // Touch getTask so the optional handler is wired even when unused.
  void handlers.getTask;

  return {
    disconnect: () => {
      micStream.getTracks().forEach((track) => track.stop());
      pc.close();
      audio.remove();
    },
    startPushToTalk: () => {
      if (recordingActive) {
        return;
      }
      recordingActive = true;
      // Silence Murphy mid-utterance. Mute (not pause) — pausing a live WebRTC
      // MediaStream can leave the <audio> element in a state that doesn't
      // recover. Mute is non-destructive: stream keeps flowing, output is silent.
      audio.muted = true;
      // Only ask the server to stop generating if we know it's mid-response.
      if (responseActive) {
        send({ type: "response.cancel" });
        responseActive = false;
      }
      audioTrack.enabled = true;
      handlers.onStatus("recording", "Recording while Space is held");
      handlers.onActivity("Push-to-talk started.");
    },
    stopPushToTalk: () => {
      if (!recordingActive) {
        return;
      }
      recordingActive = false;
      audioTrack.enabled = false;
      audio.muted = false;
      handlers.onStatus("ready", "Processing speech");
      handlers.onActivity("Push-to-talk released.");
      send({ type: "input_audio_buffer.commit" });
      send({ type: "response.create" });
    },
    sendToolOutput: (callId, output) => {
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output)
        }
      });
      send({ type: "response.create" });
    }
  };
}
