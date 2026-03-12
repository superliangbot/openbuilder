/**
 * offscreen.js — Offscreen document for tab audio capture
 *
 * Service workers cannot use MediaRecorder directly.
 * This offscreen document receives a media stream ID, captures audio,
 * and sends recorded chunks back to the background service worker.
 */

"use strict";

let recorder = null;
let stream = null;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "startRecording") {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: msg.streamId,
          },
        },
      });

      recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          // Convert blob to base64 for message passing
          const reader = new FileReader();
          reader.onloadend = () => {
            chrome.runtime.sendMessage({
              type: "audioChunk",
              data: reader.result,
            });
          };
          reader.readAsDataURL(event.data);
        }
      };

      // Record in 30-second chunks
      recorder.start(30000);
      console.log("[OpenBuilder] Offscreen audio recording started");
    } catch (err) {
      console.error("[OpenBuilder] Offscreen recording error:", err);
    }
  }

  if (msg.type === "stopRecording") {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    recorder = null;
    console.log("[OpenBuilder] Offscreen audio recording stopped");
  }
});
