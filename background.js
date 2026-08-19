"use strict";

importScripts("common.js", "mattermost.js");

// Запросы к Mattermost идут отсюда, а не из страницы: сервис-воркер
// расширения не ограничен CORS и умеет слать сессионную куку MMAUTHTOKEN,
// поэтому логин и пароль хранить не нужно — достаточно открытого в этом же
// браузере Mattermost.
const SNAPSHOT_TTL = 60000;
const snapshots = new Map();

class MMError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "error";
  }
}

function originPattern(baseUrl) {
  const origin = VRMattermost.originOf(VRMattermost.normalizeBaseUrl(baseUrl));
  return origin ? `${origin}/*` : "";
}

async function hasAccess(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

// Токен сессии лежит в куке MMAUTHTOKEN. Его же Mattermost принимает как
// Bearer, и это надёжнее отправки куки: не зависит от SameSite.
async function sessionToken(baseUrl) {
  try {
    const cookie = await chrome.cookies.get({ url: baseUrl, name: "MMAUTHTOKEN" });
    return cookie?.value || "";
  } catch (_error) {
    return "";
  }
}

async function request(baseUrl, path, { method = "GET", body } = {}) {
  const normalized = VRMattermost.normalizeBaseUrl(baseUrl);
  if (!normalized) throw new MMError("Укажите адрес Mattermost, например https://mm.example.com.", "config");
  if (!(await hasAccess(normalized))) {
    throw new MMError("Расширению не разрешён доступ к этому адресу. Нажмите «Войти» в окне расширения.", "permission");
  }

  const token = await sessionToken(normalized);
  let response;
  try {
    response = await fetch(VRMattermost.apiUrl(normalized, path), {
      method,
      credentials: "include",
      headers: {
        // Без этого заголовка Mattermost отклоняет авторизацию по куке.
        "X-Requested-With": "XMLHttpRequest",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (_error) {
    throw new MMError("Mattermost недоступен: проверьте адрес и подключение к сети.", "network");
  }

  if (response.status === 401) {
    throw new MMError("Нужно войти в Mattermost в этом браузере — откройте его и авторизуйтесь.", "auth");
  }
  if (response.status === 403) {
    throw new MMError("Нет прав на этот канал в Mattermost.", "forbidden");
  }
  if (response.status === 404) {
    throw new MMError("Команда или канал не найдены в Mattermost.", "notfound");
  }
  if (!response.ok) {
    throw new MMError(`Mattermost ответил ошибкой HTTP ${response.status}.`, "http");
  }
  return response.json();
}

async function fetchTeams(baseUrl) {
  const teams = await request(baseUrl, "/users/me/teams");
  return teams
    .filter((team) => !team.delete_at)
    .map((team) => ({ id: team.id, name: team.name, displayName: team.display_name || team.name }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ru"));
}

async function fetchChannels(baseUrl, teamId) {
  const channels = await request(baseUrl, `/users/me/teams/${teamId}/channels`);
  return channels
    .filter((channel) => ["O", "P"].includes(channel.type) && !channel.delete_at)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      displayName: channel.display_name || channel.name,
      private: channel.type === "P"
    }))
    .sort(VRMattermost.compareChannels);
}

async function fetchChannel(baseUrl, source) {
  if (source.channelId) return request(baseUrl, `/channels/${source.channelId}`);
  if (source.teamName && source.channelName) {
    return request(baseUrl, `/teams/name/${encodeURIComponent(source.teamName)}/channels/name/${encodeURIComponent(source.channelName)}`);
  }
  throw new MMError("Не выбран канал Mattermost.", "config");
}

async function fetchChannelUsers(baseUrl, channelId) {
  const users = [];
  for (let page = 0; page < 20; page += 1) {
    const batch = await request(baseUrl, `/users?in_channel=${channelId}&per_page=200&page=${page}&active=true`);
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users.filter((user) => !user.is_bot && !user.delete_at);
}

async function fetchStatuses(baseUrl, userIds) {
  const byId = new Map();
  for (let index = 0; index < userIds.length; index += 100) {
    const batch = await request(baseUrl, "/users/status/ids", {
      method: "POST",
      body: userIds.slice(index, index + 100)
    });
    batch.forEach((status) => byId.set(status.user_id, status));
  }
  return byId;
}

async function buildSnapshot(source) {
  const baseUrl = VRMattermost.normalizeBaseUrl(source.baseUrl);
  const channel = await fetchChannel(baseUrl, source);
  const users = await fetchChannelUsers(baseUrl, channel.id);
  const statuses = await fetchStatuses(baseUrl, users.map((user) => user.id));
  const members = users
    .map((user) => VRMattermost.memberFromUser(user, statuses.get(user.id)))
    .filter((member) => member.name)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  return {
    fetchedAt: Date.now(),
    channel: {
      id: channel.id,
      name: channel.name,
      displayName: channel.display_name || channel.name,
      private: channel.type === "P"
    },
    members
  };
}

async function getSnapshot(source, force) {
  const key = VRMattermost.sourceKey(source);
  if (!key) throw new MMError("Список не привязан к каналу Mattermost.", "config");

  const cached = snapshots.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < SNAPSHOT_TTL) {
    return { ...cached, cached: true };
  }
  try {
    const snapshot = await buildSnapshot(source);
    snapshots.set(key, snapshot);
    return { ...snapshot, cached: false };
  } catch (error) {
    // Просроченный кеш лучше пустого экрана: показываем его с пометкой.
    if (cached) return { ...cached, cached: true, stale: true, warning: error.message };
    throw error;
  }
}

// Редактор всегда открывается одним и тем же способом — отдельным окном, и
// со значка расширения, и по шестерёнке на странице. Боковая панель не
// подходит: Chrome разрешает открывать её только по жесту внутри расширения,
// поэтому со страницы она была недоступна, и поведение расходилось.
let editorWindowId = null;

async function editorIsOpen() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "VRM_PANEL_PING" });
    return response?.ok === true;
  } catch (_error) {
    return false;
  }
}

async function focusEditorWindow() {
  if (editorWindowId === null) return false;
  try {
    await chrome.windows.update(editorWindowId, { focused: true, drawAttention: true });
    return true;
  } catch (_error) {
    editorWindowId = null;
    return false;
  }
}

async function openEditorSurface() {
  // Окно редактора уже открыто — просто выводим его вперёд. Намерение оно
  // подхватит из хранилища само.
  if (await focusEditorWindow()) return { opened: true, surface: "window" };
  // Отвечает, но окна мы не знаем (например, после перезапуска воркера) —
  // второе окно плодить не нужно.
  if (await editorIsOpen()) return { opened: true, surface: "window" };

  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 520,
      height: 760
    });
    editorWindowId = created?.id ?? null;
    return { opened: true, surface: "window" };
  } catch (error) {
    return { opened: false, needsClick: true, message: error.message };
  }
}

chrome.windows?.onRemoved?.addListener((closedId) => {
  if (closedId === editorWindowId) editorWindowId = null;
});

// Последняя встреча, о которой сообщила страница. Редактор в отдельном окне
// узнаёт из этого, к какой вкладке относиться: сам он видит только себя.
const MEETING_KEY = "lastMeeting";

const handlers = {
  async VRM_MEETING_HERE({ roomKey, titleKey, title }, sender) {
    const tabId = sender?.tab?.id;
    if (tabId === undefined) return { stored: false };
    await chrome.storage.local.set({
      [MEETING_KEY]: {
        tabId,
        windowId: sender?.tab?.windowId ?? null,
        roomKey: String(roomKey || ""),
        titleKey: String(titleKey || ""),
        title: String(title || ""),
        at: Date.now()
      }
    });
    return { stored: true };
  },
  // Редактор спрашивает контекст встречи. Отдаём только живую вкладку, иначе
  // список привяжется к закрытой комнате.
  async VRM_MEETING_CONTEXT() {
    const stored = (await chrome.storage.local.get(MEETING_KEY))[MEETING_KEY];
    if (!stored?.tabId) return { meeting: null };
    try {
      await chrome.tabs.get(stored.tabId);
    } catch (_error) {
      return { meeting: null };
    }
    return { meeting: stored };
  },
  async VRM_MM_CONNECT({ baseUrl }) {
    const user = await request(baseUrl, "/users/me");
    return { user: { id: user.id, username: user.username, name: VRMattermost.displayName(user) } };
  },
  async VRM_MM_TEAMS({ baseUrl }) {
    return { teams: await fetchTeams(baseUrl) };
  },
  async VRM_MM_CHANNELS({ baseUrl, teamId }) {
    return { channels: await fetchChannels(baseUrl, teamId) };
  },
  async VRM_MM_SNAPSHOT({ source, force }) {
    return getSnapshot(source, force === true);
  },
  // Горячая перезагрузка при разработке: распакованное расширение Chrome
  // читает с диска, поэтому свежий текст файла можно раздавать без
  // перезагрузки самого расширения. В магазинной сборке не используется.
  async VRM_DEV_FILE({ file }) {
    const allowed = [
      "content.css", "content.js", "common.js", "mattermost.js",
      "storage.js", "bridge.js", "participants-source.js", "page-hook.js"
    ];
    if (!allowed.includes(file)) throw new MMError("Неизвестный файл.", "config");
    const response = await fetch(chrome.runtime.getURL(file));
    return { text: await response.text() };
  },
  // Chrome держит content-скрипты в памяти до перезагрузки расширения, поэтому
  // при изменении JS перезагружается расширение целиком: контексты на
  // страницах умирают, их наблюдатели сами обновляют вкладки — уже со свежим
  // кодом. В магазинной сборке не используется.
  async VRM_DEV_RELOAD() {
    if (!chrome.runtime.getManifest().update_url) chrome.runtime.reload();
    return {};
  },
  // Пост уходит от имени вошедшего пользователя: используется его же сессия.
  async VRM_MM_POST({ source, message }) {
    const text = String(message || "").trim();
    if (!text) throw new MMError("Пустое сообщение не отправлено.", "config");
    const baseUrl = VRMattermost.normalizeBaseUrl(source?.baseUrl);
    const channel = await fetchChannel(baseUrl, source || {});
    const post = await request(baseUrl, "/posts", {
      method: "POST",
      body: { channel_id: channel.id, message: text }
    });
    return { postId: post.id, channel: channel.display_name || channel.name || "" };
  },
  async VRM_MM_ACCESS({ baseUrl }) {
    return { granted: await hasAccess(baseUrl) };
  },
  // Редактор живёт в боковой панели. Со страницы просят её открыть: намерение
  // сохраняется всегда, а само открытие Chrome может отклонить, если сочтёт,
  // что жеста пользователя не было — тогда панель откроют значком, и намерение
  // применится там.
  async VRM_OPEN_EDITOR({ rosterId, blank }) {
    await chrome.storage.local.set({
      editorIntent: { rosterId: String(rosterId || ""), blank: blank === true, at: Date.now() }
    });
    return openEditorSurface();
  },
  // Состояние подключения одним запросом: выдан ли доступ к домену, есть ли
  // сессионная кука и под кем мы вошли. Нужно, чтобы не показывать «Войти»
  // тому, кто уже вошёл.
  async VRM_MM_SESSION({ baseUrl }) {
    const normalized = VRMattermost.normalizeBaseUrl(baseUrl);
    const empty = { granted: false, hasSession: false, user: null };
    if (!normalized || !(await hasAccess(normalized))) return empty;
    if (!(await sessionToken(normalized))) return { ...empty, granted: true };

    try {
      const user = await request(normalized, "/users/me");
      return {
        granted: true,
        hasSession: true,
        user: { id: user.id, username: user.username, name: VRMattermost.displayName(user) }
      };
    } catch (_error) {
      return { ...empty, granted: true };
    }
  }
};

chrome.action.onClicked.addListener(() => {
  openEditorSurface().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return undefined;
  handler(message, sender)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, code: error.code || "error", message: error.message }));
  return true;
});
