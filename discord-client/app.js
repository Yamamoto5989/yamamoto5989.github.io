(() => {
  const API_BASE = window.API_BASE;

  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  const loginBtn = document.getElementById("login-btn");
  const menuBtn = document.getElementById("menu-btn");
  const sidebar = document.getElementById("sidebar");
  const guildList = document.getElementById("guild-list");
  const textChannelList = document.getElementById("text-channel-list");
  const voiceChannelList = document.getElementById("voice-channel-list");
  const currentChannelName = document.getElementById("current-channel-name");
  const meName = document.getElementById("me-name");
  const messagesEl = document.getElementById("messages");
  const sendForm = document.getElementById("send-form");
  const msgInput = document.getElementById("msg-input");
  const voiceBar = document.getElementById("voice-bar");
  const voiceChannelNameEl = document.getElementById("voice-channel-name");
  const voiceLeaveBtn = document.getElementById("voice-leave-btn");

  let token = localStorage.getItem("token");
  let socket = null;
  let currentChannelId = null;
  let currentGuildId = null;
  let currentVoiceGuildId = null;

  // ---------- 起動時: URLハッシュにトークンがあれば保存 ----------
  if (location.hash.startsWith("#token=")) {
    token = location.hash.slice("#token=".length);
    localStorage.setItem("token", token);
    history.replaceState(null, "", location.pathname);
  }

  loginBtn.addEventListener("click", () => {
    location.href = `${API_BASE}/auth/login`;
  });

  if (token) {
    init();
  }

  async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      logout();
      throw new Error("unauthorized");
    }
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  function logout() {
    localStorage.removeItem("token");
    location.reload();
  }

  async function init() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");

    const me = await apiGet("/api/me");
    meName.textContent = me.username;

    socket = io(API_BASE, { auth: { token } });
    socket.on("message", (msg) => {
      if (msg && currentChannelId) appendMessage(msg);
    });
    socket.on("audioChunk", (data) => {
      playPcmChunk(data.chunk);
    });

    await loadGuilds();
  }

  async function loadGuilds() {
    const guilds = await apiGet("/api/guilds");
    guildList.innerHTML = "";
    guilds.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "list-item";
      btn.textContent = g.name;
      btn.addEventListener("click", () => selectGuild(g.id, g.name));
      guildList.appendChild(btn);
    });
  }

  async function selectGuild(guildId) {
    currentGuildId = guildId;
    const [textChannels, voiceChannels] = await Promise.all([
      apiGet(`/api/guilds/${guildId}/text-channels`),
      apiGet(`/api/guilds/${guildId}/voice-channels`),
    ]);

    textChannelList.innerHTML = "<b># テキスト</b>";
    textChannels.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "list-item";
      btn.textContent = `# ${c.name}`;
      btn.addEventListener("click", () => selectTextChannel(c.id, c.name));
      textChannelList.appendChild(btn);
    });

    voiceChannelList.innerHTML = "<b>🔊 ボイス</b>";
    voiceChannels.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "list-item";
      btn.textContent = `🔊 ${c.name} (${c.memberCount})`;
      btn.addEventListener("click", () => joinVoice(guildId, c.id, c.name));
      voiceChannelList.appendChild(btn);
    });

    sidebar.classList.add("hidden"); // モバイルでは選択後に自動で閉じる
  }

  async function selectTextChannel(channelId, name) {
    if (currentChannelId) socket.emit("leave-channel", currentChannelId);
    currentChannelId = channelId;
    socket.emit("join-channel", channelId);
    currentChannelName.textContent = `# ${name}`;

    const messages = await apiGet(`/api/channels/${channelId}/messages`);
    messagesEl.innerHTML = "";
    messages.forEach(appendMessage);
  }

  function appendMessage(msg) {
    const div = document.createElement("div");
    div.className = "message";
    div.innerHTML = `
      <img class="avatar" src="${msg.authorAvatar || ""}" />
      <div class="msg-body">
        <span class="msg-author">${escapeHtml(msg.authorName)}</span>
        <div class="msg-content">${escapeHtml(msg.content)}</div>
      </div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentChannelId || !msgInput.value.trim()) return;
    const content = msgInput.value;
    msgInput.value = "";
    await apiPost(`/api/channels/${currentChannelId}/messages`, { content });
  });

  menuBtn.addEventListener("click", () => {
    sidebar.classList.toggle("hidden");
  });

  // ---------- VC ----------
  async function joinVoice(guildId, channelId, name) {
    if (currentVoiceGuildId) {
      socket.emit("leave-voice-room", currentVoiceGuildId);
    }
    await apiPost("/api/voice/join", { guildId, channelId });
    currentVoiceGuildId = guildId;
    socket.emit("join-voice-room", guildId);
    voiceChannelNameEl.textContent = name;
    voiceBar.classList.remove("hidden");
    await ensureAudioContext();
  }

  voiceLeaveBtn.addEventListener("click", async () => {
    if (!currentVoiceGuildId) return;
    await apiPost("/api/voice/leave", { guildId: currentVoiceGuildId });
    socket.emit("leave-voice-room", currentVoiceGuildId);
    currentVoiceGuildId = null;
    voiceBar.classList.add("hidden");
  });

  // ---------- 受信音声の再生(Web Audio API) ----------
  let audioCtx = null;
  const nextStartTime = new Map(); // userId(実際はsocket上ではバイナリのみ届くため簡易的に単一ストリーム扱い)

  async function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume(); // モバイルはユーザー操作後でないと再生開始できないため
    }
  }

  function playPcmChunk(arrayBuffer) {
    if (!audioCtx) return;
    // Discordの生PCM: 16bit signed little-endian, 48kHz, stereo
    const dataView = new DataView(arrayBuffer);
    const sampleCount = arrayBuffer.byteLength / 2 / 2; // 2byte * 2ch
    const audioBuffer = audioCtx.createBuffer(2, sampleCount, 48000);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);

    for (let i = 0; i < sampleCount; i++) {
      const li = dataView.getInt16(i * 4, true) / 32768;
      const ri = dataView.getInt16(i * 4 + 2, true) / 32768;
      left[i] = li;
      right[i] = ri;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    const key = "main";
    const now = audioCtx.currentTime;
    const startAt = Math.max(now, nextStartTime.get(key) || 0);
    source.start(startAt);
    nextStartTime.set(key, startAt + audioBuffer.duration);
  }
})();
