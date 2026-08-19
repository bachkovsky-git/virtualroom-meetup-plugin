(function (root) {
  "use strict";

  // Источник списка участников для content.js. Основной путь — page-hook.js
  // в мире страницы, который отдаёт участников из сервисов самого клиента
  // VirtualRoom; пока он не подтвердил работу (или сломался), источник
  // остаётся в режиме "dom", и content.js собирает имена прокруткой списка,
  // как раньше.

  const bridge = root.VRMBridge;

  const HOOK_TIMEOUT_MS = 5000;
  const RETRY_MS = 30000;
  const REFRESH_TIMEOUT_MS = 3000;

  let state = "idle"; // idle | starting | hook | dom
  let lastNames = null;
  let lastSeq = 0;
  let startTimer = 0;
  let retryTimer = 0;
  const nameListeners = [];
  const modeListeners = [];
  const refreshWaiters = [];

  function send(type, payload) {
    root.postMessage(bridge.envelope(type, payload), root.location.origin);
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    modeListeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        // Ошибка одного подписчика не должна валить остальных.
      }
    });
  }

  function toDomMode() {
    clearTimeout(startTimer);
    startTimer = 0;
    setState("dom");
    // Хук мог не завестись из-за незагруженной комнаты — пробуем ещё,
    // пока страница жива; повторный START для page-hook идемпотентен.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      start();
    }, RETRY_MS);
  }

  function start() {
    if (state === "hook" || state === "starting") return;
    setState("starting");
    send("HOOK_START");
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      if (state !== "hook") toDomMode();
    }, HOOK_TIMEOUT_MS);
  }

  function acceptNames(names) {
    lastNames = names;
    clearTimeout(startTimer);
    startTimer = 0;
    setState("hook");
    while (refreshWaiters.length) {
      const waiter = refreshWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(names);
    }
    nameListeners.forEach((listener) => {
      try {
        listener(names);
      } catch (error) {
        // См. setState: подписчики независимы.
      }
    });
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.origin !== root.location.origin) return;
    const message = bridge.parseEnvelope(event.data);
    if (!message) return;
    if (message.type === "PARTICIPANTS") {
      if (!bridge.validParticipantsPayload(message.payload)) return;
      if (message.payload.seq <= lastSeq) return;
      lastSeq = message.payload.seq;
      acceptNames(message.payload.names);
      return;
    }
    if (message.type === "HOOK_STATUS") {
      const hookState = message.payload.state;
      // "active" сам по себе режим не включает: ждём первых данных, иначе
      // раздел рисовался бы по пустому списку.
      if (hookState === "lost" || hookState === "failed") toDomMode();
    }
  });

  // Обновление по требованию: page-hook дёргает getVirtualRoomInfo, ответ
  // приедет обычной эмиссией PARTICIPANTS. Не дождались — отдаём последнее
  // известное, а совсем без данных отклоняемся, чтобы вызвавший ушёл в DOM.
  function refresh() {
    return new Promise((resolve, reject) => {
      if (state !== "hook") {
        reject(new Error("Источник участников не подключён."));
        return;
      }
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        const index = refreshWaiters.indexOf(waiter);
        if (index !== -1) refreshWaiters.splice(index, 1);
        if (lastNames) resolve(lastNames);
        else reject(new Error("Источник участников не ответил."));
      }, REFRESH_TIMEOUT_MS);
      refreshWaiters.push(waiter);
      send("REFRESH");
    });
  }

  root.VRMSource = {
    get state() {
      return state;
    },
    get lastNames() {
      return lastNames;
    },
    start,
    refresh,
    onNames(listener) {
      nameListeners.push(listener);
    },
    onModeChange(listener) {
      modeListeners.push(listener);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
