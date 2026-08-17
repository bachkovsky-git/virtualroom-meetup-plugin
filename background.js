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

const handlers = {
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
  async VRM_MM_ACCESS({ baseUrl }) {
    return { granted: await hasAccess(baseUrl) };
  },
  // Редактор живёт в боковой панели. Со страницы просят её открыть: намерение
  // сохраняется всегда, а само открытие Chrome может отклонить, если сочтёт,
  // что жеста пользователя не было — тогда панель откроют значком, и намерение
  // применится там.
  async VRM_OPEN_EDITOR({ rosterId, blank }, sender) {
    await chrome.storage.local.set({
      editorIntent: { rosterId: String(rosterId || ""), blank: blank === true, at: Date.now() }
    });

    const windowId = sender?.tab?.windowId;
    if (!chrome.sidePanel?.open || windowId === undefined) return { opened: false, needsClick: true };
    try {
      await chrome.sidePanel.open({ windowId });
      return { opened: true };
    } catch (_error) {
      return { opened: false, needsClick: true };
    }
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

// Всплывающее окно расширения Chrome закрывает при любой потере фокуса, и
// отключить это нельзя. Поэтому иконка открывает боковую панель: она живёт,
// пока её не закроют, и переживает переключение окон и вкладок.
function enableSidePanel() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();

// Запасной путь для сборок без Side Panel API: то же окно настроек, но
// отдельным окном браузера.
if (!chrome.sidePanel) {
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 520,
      height: 720
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return undefined;
  handler(message, sender)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, code: error.code || "error", message: error.message }));
  return true;
});
