(function () {
  "use strict";

  // Работает в мире страницы VirtualRoom. Из-за matches <all_urls> скрипт
  // попадает на все сайты, поэтому до команды HOOK_START он только слушает
  // сообщения и ничего не ищет. START шлёт расширение — и лишь тогда, когда
  // нашло на странице разметку панели участников VirtualRoom.
  //
  // Источник данных — сервисы самого клиента: контейнер inversify достаётся
  // через внутренние поля React (root → __reactContainer$… → memoizedProps),
  // а дальше используются только строковые DI-токены и wire-поля, которые
  // не меняются минификацией. Любая неудача здесь не должна ломать страницу:
  // всё обёрнуто в try/catch, о сбое сообщает HOOK_STATUS, а расширение
  // само откатывается на чтение DOM.

  if (typeof window === "undefined" || !window.VRMBridge) return;
  const bridge = window.VRMBridge;

  const PARTICIPANTS_STORE = "Room/ParticipantsStore";
  const ACCESS_SERVICE = "Room/AccessServiceProvider";
  const FIND_RETRY_MS = 1000;
  const FIND_ATTEMPTS = 15;
  const PUBLISH_DEBOUNCE_MS = 250;
  const FIBER_NODE_LIMIT = 5000;

  let container = null;
  let store = null;
  let subscription = null;
  let lastNames = null;
  let seq = 0;
  let findTimer = 0;
  let publishTimer = 0;
  let starting = false;

  function send(type, payload) {
    try {
      window.postMessage(bridge.envelope(type, payload), window.location.origin);
    } catch (error) {
      // Отправка не должна ронять страницу даже при неклонируемом payload.
    }
  }

  function sendStatus(state, detail) {
    send("HOOK_STATUS", detail ? { state, detail: String(detail) } : { state });
  }

  function publish(list) {
    lastNames = bridge.namesFromParticipants(list);
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      send("PARTICIPANTS", { names: lastNames, seq: ++seq, ts: Date.now() });
    }, PUBLISH_DEBOUNCE_MS);
  }

  function findContainer() {
    const root = document.getElementById("root");
    if (!root) return null;
    const containerKey = Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
    if (!containerKey) return null;
    let node = root[containerKey];
    let visited = 0;
    while (node && visited < FIBER_NODE_LIMIT) {
      visited += 1;
      const candidate = node.memoizedProps?.container;
      if (candidate && typeof candidate.get === "function") return candidate;
      if (node.child) {
        node = node.child;
        continue;
      }
      while (node && !node.sibling) node = node.return;
      node = node?.sibling || null;
    }
    return null;
  }

  function detach() {
    try {
      subscription?.unsubscribe?.();
    } catch (error) {
      // Отписка от умершего потока не должна мешать переподключению.
    }
    subscription = null;
    store = null;
  }

  function attach(found) {
    container = found;
    store = container.get(PARTICIPANTS_STORE);
    const stream = store?.sortedParticipants$ || store?.participants$;
    if (!stream || typeof stream.subscribe !== "function") {
      throw new Error("participants stream missing");
    }
    subscription = stream.subscribe({
      next: (list) => {
        try {
          // participants$ может отдавать Map, sortedParticipants$ — массив.
          publish(Array.isArray(list) ? list : Array.from(list?.values?.() || []));
        } catch (error) {
          sendStatus("lost", error?.message);
        }
      },
      error: (error) => {
        detach();
        sendStatus("lost", error?.message);
      },
      complete: () => {
        detach();
        sendStatus("lost", "stream completed");
      }
    });
  }

  function startAttempts() {
    if (starting) return;
    starting = true;
    let attempts = 0;
    const attempt = () => {
      let found = null;
      try {
        found = findContainer();
        if (found) {
          attach(found);
          starting = false;
          sendStatus("active");
          return;
        }
      } catch (error) {
        starting = false;
        detach();
        sendStatus("failed", error?.message);
        return;
      }
      attempts += 1;
      if (attempts >= FIND_ATTEMPTS) {
        starting = false;
        sendStatus("failed", "container not found");
        return;
      }
      findTimer = setTimeout(attempt, FIND_RETRY_MS);
    };
    attempt();
  }

  function ensureStarted() {
    // Живая подписка и тот же инстанс store — делать нечего; BehaviorSubject
    // уже прислал текущее значение при подписке, но повторный START значит,
    // что расширение могло пропустить его (перезагрузка панели) — шлём снова.
    if (subscription && store) {
      try {
        if (container?.get(PARTICIPANTS_STORE) === store) {
          sendStatus("active");
          if (lastNames) send("PARTICIPANTS", { names: lastNames, seq: ++seq, ts: Date.now() });
          return;
        }
      } catch (error) {
        // Контейнер умер — переподключаемся ниже.
      }
      detach();
    }
    clearTimeout(findTimer);
    starting = false;
    startAttempts();
  }

  function refresh() {
    try {
      container?.get(ACCESS_SERVICE)?.getVirtualRoomInfo?.();
      // Свежая эмиссия придёт обычным путём через подписку.
    } catch (error) {
      if (lastNames) send("PARTICIPANTS", { names: lastNames, seq: ++seq, ts: Date.now() });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = bridge.parseEnvelope(event.data);
    if (!message) return;
    try {
      if (message.type === "HOOK_START") ensureStarted();
      else if (message.type === "REFRESH") refresh();
    } catch (error) {
      sendStatus("lost", error?.message);
    }
  });
})();
