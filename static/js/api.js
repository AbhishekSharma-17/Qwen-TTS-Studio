// Thin wrapper over fetch for the orchestrator API.

export async function getJSON(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

export async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return r;
}

export async function del(path) {
  const r = await fetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}`);
  return r.json();
}

/**
 * POST /v1/audio/speech that may return a streamed PCM body OR a full WAV blob.
 * @returns {Promise<Response>}
 */
export async function postSpeech(body) {
  const r = await fetch("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg += `: ${(await r.json()).detail}`; } catch {}
    throw new Error(msg);
  }
  return r;
}

export async function uploadVoice({ file, name, refText, description, consent, language }) {
  const fd = new FormData();
  fd.append("audio_sample", file);
  fd.append("name", name);
  fd.append("consent", consent ?? `ui-${Date.now()}`);
  if (refText) fd.append("ref_text", refText);
  if (description) fd.append("speaker_description", description);
  if (language) fd.append("language", language);
  const r = await fetch("/v1/audio/voices", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload failed (${r.status}): ${await r.text()}`);
  return r.json();
}

export async function listVoices() {
  return getJSON("/v1/audio/voices");
}

export async function getHealth() { return getJSON("/health"); }
export async function getInfo() { return getJSON("/info"); }
export async function getLanguages() { return getJSON("/v1/tts/languages"); }
export async function getTasks() { return getJSON("/v1/tts/tasks"); }
