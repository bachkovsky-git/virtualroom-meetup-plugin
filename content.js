(function () {
  "use strict";

  const NAME_SELECTOR = '[class*="ParticipantName"]';
  const LIST_CONTAINER_SELECTOR = '[class*="ParticipantListContainer"]';
  const SCROLLER_SELECTOR = '.participant-list, [class*="GridScrollContainer"]';
  const MISSING_ID = "vrm-attendance-missing";
  const STATUS_MENU_ID = "vrm-attendance-status-menu";
  const GEAR_PATH = "m14.54 7.37 1.065-.58a.755.755 0 0 0 .366-.873c-.366-1.356-1.132-2.583-2.13-3.584-.266-.226-.666-.29-.965-.13l-1.065.614a4.5 4.5 0 0 0-1.098-.613V1.009c0-.355-.233-.646-.6-.743a8.5 8.5 0 0 0-4.226 0c-.366.097-.6.388-.6.743v1.195a4.5 4.5 0 0 0-1.098.613l-1.065-.613c-.3-.162-.699-.097-.965.129C1.161 3.334.395 4.561.03 5.917c-.1.355.067.71.366.872l1.065.581c-.033.226-.033.42-.033.646 0 .194 0 .388.033.581l-1.065.614a.755.755 0 0 0-.366.872c.366 1.356 1.132 2.583 2.13 3.584.266.226.666.29.965.13l1.065-.614c.333.258.7.452 1.099.613v1.195c0 .355.233.646.599.743a8.5 8.5 0 0 0 4.226 0c.367-.097.6-.388.6-.743v-1.195c.399-.161.765-.355 1.098-.613l1.065.613c.3.162.699.097.965-.129.998-1.001 1.764-2.228 2.13-3.584a.755.755 0 0 0-.366-.872l-1.065-.614a7.6 7.6 0 0 0 0-1.227m-1.764 2.067 1.464.807c-.266.678-.632 1.324-1.131 1.873l-1.465-.807c-1.065.872-1.198.968-2.53 1.42v1.647a6.4 6.4 0 0 1-2.229 0v-1.646c-1.331-.453-1.498-.55-2.53-1.421l-1.464.807c-.499-.549-.865-1.195-1.131-1.873l1.464-.807c-.266-1.356-.266-1.518 0-2.874L1.76 5.756c.266-.678.632-1.324 1.131-1.873l1.465.807c1.065-.872 1.198-.969 2.53-1.42V1.622a6.4 6.4 0 0 1 2.229 0v1.646c1.331.452 1.498.55 2.53 1.421l1.464-.807c.499.549.865 1.195 1.131 1.873l-1.464.807c.266 1.356.266 1.518 0 2.874m-4.76-4.553c-1.763 0-3.194 1.42-3.194 3.1 0 1.711 1.43 3.1 3.195 3.1 1.73 0 3.195-1.389 3.195-3.1 0-1.68-1.465-3.1-3.195-3.1m0 4.65c-.898 0-1.597-.678-1.597-1.55 0-.84.699-1.55 1.598-1.55.865 0 1.597.71 1.597 1.55 0 .872-.732 1.55-1.597 1.55";
  const AUTO_SCAN_DELAY = 1200;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  let state = {
    rosters: [],
    roomAssignments: {},
    titleAssignments: {},
    selectedRosterId: null,
    highlightPresent: true,
    missingCollapsed: false
  };
  let activeRoster = null;
  let scanning = false;
  let autoScanTimer = null;
  let ignoreMutationsUntil = 0;
  let statusMenuOutsideHandler = null;
  let statusMenuAnchor = null;
  let lastActualNames = new Map();
  let midnightRefreshTimer = null;
  let mattermostRefreshTimer = null;
  let mmMembers = new Map();
  let mmSnapshot = null;
  let mmNotice = "";
  let appliedSnapshotKey = "";
  let lastRenderSignature = "";
  let lastUserScrollAt = 0;
  let panelHovered = false;
  let programmaticScroll = false;
  let autoScanWaitingSince = 0;
  let watchedScroller = null;
  let resultCache = {};
  let editorHint = "";
  let editorHintTimer = null;

  function currentRoomKey() {
    return VRMeetups.roomKey(location.href);
  }

  function currentTitleKey() {
    return VRMeetups.roomTitleKey(document.title);
  }

  // В комнате берётся только тот список, который к ней привязан: если привязки
  // нет, вместо чужого списка показывается приглашение выбрать свой.
  async function loadActiveRoster(preferredRosterId) {
    state = await VRMStorage.load();
    activeRoster = VRMeetups.rosterById(state.rosters, preferredRosterId) ||
      VRMeetups.assignedRoster(state, currentRoomKey(), currentTitleKey());
    return activeRoster;
  }

  // Выбор списка на встрече и есть «запомнить»: пишем обе привязки сразу.
  async function bindRosterToRoom(rosterId) {
    const roster = VRMeetups.rosterById(state.rosters, rosterId);
    if (!roster) return null;

    state.roomAssignments = { ...state.roomAssignments, [currentRoomKey()]: roster.id };
    const titleKey = currentTitleKey();
    if (titleKey) state.titleAssignments = { ...state.titleAssignments, [titleKey]: roster.id };
    state.selectedRosterId = roster.id;

    ignoreMutationsUntil = Date.now() + 1000;
    state = await VRMStorage.save(state);
    activeRoster = VRMeetups.rosterById(state.rosters, roster.id);
    appliedSnapshotKey = "";
    return activeRoster;
  }

  async function chooseRoster(rosterId) {
    closeStatusMenu();
    if (!(await bindRosterToRoom(rosterId))) return;
    await scanParticipants(activeRoster.id);
  }

  function scheduleMidnightRefresh() {
    clearTimeout(midnightRefreshTimer);
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 1, 0);
    midnightRefreshTimer = setTimeout(async () => {
      await loadActiveRoster();
      if (activeRoster && findPanel()) await scanParticipants(activeRoster.id);
      else updatePresentMarkers();
      scheduleMidnightRefresh();
    }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
  }

  // --- Mattermost ---------------------------------------------------------

  // Состав канала подтягивается всегда, а показ статусов можно выключить:
  // это две независимые вещи.
  function mattermostLinked() {
    return VRMattermost.isMattermost(activeRoster);
  }

  function mattermostStatusesShown() {
    return state.showMattermostStatuses !== false;
  }

  function memberForName(name) {
    const key = VRMeetups.comparisonKey(name);
    if (mmMembers.has(key)) return mmMembers.get(key);
    for (const [memberKey, member] of mmMembers) {
      if (VRMeetups.namesMatch(memberKey, key)) return member;
    }
    return null;
  }

  // Состав канала — источник истины: участники и их ники переезжают в список.
  async function applyMattermostSnapshot(snapshot) {
    const snapshotKey = `${activeRoster?.id}:${VRMattermost.sourceKey(activeRoster?.source)}@${snapshot.fetchedAt}`;
    if (appliedSnapshotKey === snapshotKey) return;
    appliedSnapshotKey = snapshotKey;

    const index = state.rosters.findIndex((roster) => roster.id === activeRoster?.id);
    if (index < 0) return;
    const current = state.rosters[index];
    const { participants, aliases } = VRMattermost.applySnapshot(current, snapshot.members);
    const unchanged = JSON.stringify(current.participants) === JSON.stringify(participants) &&
      JSON.stringify(current.aliases) === JSON.stringify(aliases);
    if (unchanged) return;

    state.rosters[index] = {
      ...current,
      participants,
      aliases,
      source: { ...current.source, syncedAt: snapshot.fetchedAt },
      updatedAt: Date.now()
    };
    ignoreMutationsUntil = Date.now() + 1000;
    state = await VRMStorage.save(state);
    activeRoster = VRMeetups.rosterById(state.rosters, current.id);
  }

  async function refreshMattermost(force) {
    mmSnapshot = null;
    mmMembers = new Map();
    mmNotice = "";
    if (!mattermostLinked()) return null;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "VRM_MM_SNAPSHOT",
        source: activeRoster.source,
        force: force === true
      });
    } catch (error) {
      mmNotice = "Mattermost недоступен: перезагрузите вкладку после обновления расширения.";
      return null;
    }
    if (!response?.ok) {
      mmNotice = response?.message || "Не удалось получить данные из Mattermost.";
      return null;
    }

    mmSnapshot = response;
    if (mattermostStatusesShown()) mmMembers = VRMattermost.membersByKey(response.members);
    if (response.warning) mmNotice = `Данные из Mattermost устарели: ${response.warning}`;
    await applyMattermostSnapshot(response);
    return response;
  }

  // Статусы обновляются без повторного чтения списка: прокрутка чужой панели
  // заметна, а сравнение можно пересчитать по прошлому снимку имён.
  async function refreshMattermostStatuses() {
    if (!mattermostLinked() || !mattermostStatusesShown() || scanning) return;
    const panel = findPanel();
    if (!panel || !lastActualNames.size) return;

    markRefreshing(true);
    try {
      await refreshMattermost(true);
    } finally {
      markRefreshing(false);
    }
    if (!activeRoster) return;
    const actualNameKeys = new Set(lastActualNames.keys());
    const missing = activeRoster.participants.filter(
      (name) => !VRMeetups.participantIsPresent(activeRoster, name, actualNameKeys)
    );
    const rows = missing.map(rowView);
    renderResult(panel, rows, { expected: activeRoster.participants.length });
    rememberResult(rows);
    updatePresentMarkers();
    ignoreMutationsUntil = Date.now() + 1000;
  }

  function scheduleMattermostRefresh() {
    clearInterval(mattermostRefreshTimer);
    mattermostRefreshTimer = setInterval(refreshMattermostStatuses, 300000);
  }

  // --- Кеш последней проверки ---------------------------------------------

  function currentResultKey() {
    return VRMeetups.resultKey(currentRoomKey(), activeRoster?.id);
  }

  function markRefreshing(active) {
    document.getElementById(MISSING_ID)?.classList.toggle("vrm-is-refreshing", active === true);
  }

  function rememberResult(rows) {
    const key = currentResultKey();
    if (!key || !activeRoster) return;
    const entry = { rows, expected: activeRoster.participants.length, savedAt: Date.now() };
    resultCache[key] = entry;
    VRMStorage.saveResult(key, entry).catch(() => {});
  }

  // Панель могли закрыть и открыть заново — вместе с ней исчезает и наш блок.
  // Рисуем его сразу из прошлого результата, а свежий приедет фоном.
  function showRememberedResult() {
    const panel = findPanel();
    if (!panel) return false;
    if (!activeRoster) {
      renderPrompt(panel);
      return true;
    }
    const existing = document.getElementById(MISSING_ID);
    if (existing && existing.parentElement === panel.listContainer) return false;

    const entry = resultCache[currentResultKey()];
    if (!entry || !Array.isArray(entry.rows)) return false;
    renderResult(panel, entry.rows, { expected: entry.expected, stale: true });
    return true;
  }

  function readNames(scope, namesByKey) {
    scope.querySelectorAll(NAME_SELECTOR).forEach((element) => {
      const name = (element.getAttribute("title") || element.textContent || "").trim();
      const key = VRMeetups.comparisonKey(name);
      if (key && !namesByKey.has(key)) namesByKey.set(key, name);
    });
  }

  function findPanel() {
    const listContainer = document.querySelector(LIST_CONTAINER_SELECTOR);
    if (!listContainer) return null;
    const scroller = listContainer.querySelector(SCROLLER_SELECTOR);
    return scroller ? { listContainer, scroller } : null;
  }

  // Позиция возвращается в несколько проходов: виртуализация меняет высоту
  // содержимого с задержкой, и одиночное присваивание scrollTop не держится.
  async function restoreScrollTop(scroller, position) {
    const apply = () => {
      const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(position, limit);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    };
    apply();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    apply();
    await wait(60);
    apply();
  }

  async function collectAllNames(scroller) {
    const namesByKey = new Map();
    const originalScrollTop = scroller.scrollTop;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(48, Math.floor(scroller.clientHeight * 0.75));
    const startedAt = Date.now();

    readNames(scroller, namesByKey);
    if (maxScrollTop <= 0) return namesByKey;

    const previousBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    programmaticScroll = true;
    // Пользователь мог начать листать уже после запуска проверки: тогда сбор
    // прерывается на достигнутом и позиция остаётся его, а не нашей.
    const interrupted = () => lastUserScrollAt > startedAt;
    try {
      for (let position = 0, iterations = 0; position <= maxScrollTop && iterations < 500; position += step, iterations += 1) {
        if (interrupted()) break;
        scroller.scrollTop = Math.min(position, maxScrollTop);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await wait(70);
        readNames(scroller, namesByKey);
      }
      if (!interrupted()) {
        scroller.scrollTop = maxScrollTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await wait(90);
        readNames(scroller, namesByKey);
        await restoreScrollTop(scroller, originalScrollTop);
      }
    } finally {
      scroller.style.scrollBehavior = previousBehavior;
      // События прокрутки приходят на следующих кадрах, поэтому флаг снимается
      // с запасом — иначе наш же скролл сойдёт за пользовательский.
      setTimeout(() => { programmaticScroll = false; }, 150);
    }
    return namesByKey;
  }

  function expectedParticipantForActual(actualName) {
    const actualKey = VRMeetups.comparisonKey(actualName);
    const participants = activeRoster?.participants || [];
    const keysFor = (expectedName) => VRMeetups.participantMatchKeys(activeRoster, expectedName);
    // Точное совпадение проверяется первым: если в списке есть и «Иванов Иван»,
    // и «Иванов Иван Петрович», строка достанется тому, кто записан так же.
    return participants.find((expectedName) => keysFor(expectedName).includes(actualKey)) ||
      participants.find((expectedName) =>
        keysFor(expectedName).some((key) => VRMeetups.namesMatch(key, actualKey))
      ) || null;
  }

  function updatePresentMarkers() {
    // Keep VirtualRoom's avatar as the first DOM child. Its hover menu relies on
    // that structure, so the absolutely positioned marker is appended to the
    // participant row, outside the clickable avatar/name area.
    document.querySelectorAll(".vrm-present-dot").forEach((dot) => dot.remove());
    document.querySelectorAll('[data-vrm-present-user="true"]').forEach((element) => {
      element.removeAttribute("data-vrm-present-user");
    });
    if (!activeRoster) return;

    document.querySelectorAll(NAME_SELECTOR).forEach((nameElement) => {
      const name = (nameElement.getAttribute("title") || nameElement.textContent || "").trim();
      const expectedName = expectedParticipantForActual(name);
      if (!expectedName) return;
      const storedStatus = storedParticipantStatus(expectedName);
      if (!state.highlightPresent && !storedStatus) return;

      const clickableArea = nameElement.closest('[class*="ParticipantClickableArea"]');
      const avatar = clickableArea?.querySelector('.avatar-round, [class*="Avatar"]');
      const participantRow = clickableArea?.closest('[class*="ParticipantItemContainer"]');
      if (!clickableArea || !avatar || !participantRow) return;

      participantRow.setAttribute("data-vrm-present-user", "true");
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "vrm-present-dot";
      dot.setAttribute("data-vrm-extension", "true");
      const member = memberForName(expectedName);
      const mattermostText = member ? ` В Mattermost: ${VRMattermost.describe(member)}.` : "";
      dot.title = (storedStatus
        ? `${name} сопоставлен с ${expectedName}: ${statusDescription(storedStatus)}. Нажмите, чтобы изменить или снять статус`
        : `${name} — пришёл. Нажмите, чтобы установить статус`) + mattermostText;
      dot.setAttribute("aria-label", dot.title);
      dot.setAttribute("aria-haspopup", "menu");
      dot.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showStatusMenu(dot, expectedName);
      });
      participantRow.append(dot);
    });
  }

  // Меню выбора списка: одинаково открывается из шапки блока и из приглашения.
  function toggleRosterMenu(anchor) {
    if (statusMenuAnchor === anchor) {
      closeStatusMenu();
      return;
    }
    showRosterMenu(anchor);
  }

  function showRosterMenu(anchor) {
    closeStatusMenu();
    const menu = document.createElement("div");
    menu.id = STATUS_MENU_ID;
    menu.setAttribute("data-vrm-extension", "true");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Список для этой встречи");

    const heading = document.createElement("div");
    heading.className = "vrm-status-heading";
    heading.textContent = "Список для этой встречи";
    menu.append(heading);

    state.rosters.forEach((roster) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "vrm-status-option vrm-roster-option";
      item.setAttribute("role", "menuitemradio");
      const chosen = roster.id === activeRoster?.id;
      item.setAttribute("aria-checked", String(chosen));

      const icon = document.createElement("span");
      icon.className = "vrm-status-icon";
      icon.textContent = chosen ? "●" : "";
      const label = document.createElement("span");
      label.textContent = roster.name;
      item.append(icon, label);
      item.addEventListener("click", () => chooseRoster(roster.id));
      menu.append(item);
    });

    const separator = document.createElement("div");
    separator.className = "vrm-status-separator";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "vrm-status-option vrm-roster-option";
    create.setAttribute("role", "menuitem");
    const createIcon = document.createElement("span");
    createIcon.className = "vrm-status-icon";
    createIcon.textContent = "+";
    const createLabel = document.createElement("span");
    createLabel.textContent = "Создать новый";
    create.append(createIcon, createLabel);
    create.addEventListener("click", () => {
      openEditor({ blank: true });
    });
    menu.append(separator, create);

    placeStatusMenu(menu, anchor, '[aria-checked="true"], .vrm-roster-option');
  }

  function createRosterButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vrm-roster-name vrm-roster-switch";
    button.textContent = `${activeRoster.name} ▾`;
    button.title = VRMattermost.isMattermost(activeRoster)
      ? `Список «${activeRoster.name}» — состав из канала Mattermost «${activeRoster.source.channelDisplayName || activeRoster.source.channelName}». Нажмите, чтобы сменить список`
      : `Список «${activeRoster.name}». Нажмите, чтобы сменить список`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRosterMenu(button);
    });
    return button;
  }

  function createGearButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vrm-settings-button";
    button.title = "Настроить список в панели расширения";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="${GEAR_PATH}" clip-rule="evenodd"></path></svg>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEditor(activeRoster ? { rosterId: activeRoster.id } : { blank: true });
    });
    return button;
  }

  function createMattermostButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vrm-mattermost-button";
    const channel = activeRoster.source.channelDisplayName || activeRoster.source.channelName;
    if (mmNotice) {
      button.classList.add("vrm-has-warning");
      button.textContent = "!";
      button.title = `${mmNotice} Нажмите, чтобы повторить.`;
    } else {
      const synced = mmSnapshot?.fetchedAt
        ? new Date(mmSnapshot.fetchedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : "—";
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5V.8L4.6 3.2 8 5.6V3.9a4.1 4.1 0 1 1-4 5l-1.4.4A5.5 5.5 0 1 0 8 2.5z"></path></svg>';
      button.title = `Канал Mattermost «${channel}», обновлено в ${synced}. Нажмите, чтобы обновить состав и статусы`;
    }
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Вращение включается сразу: самая долгая часть — запрос в Mattermost,
      // и раньше она проходила без анимации, кнопка лишь гасла.
      button.classList.add("vrm-is-busy");
      markRefreshing(true);
      try {
        await refreshMattermost(true);
        await scanParticipants(activeRoster?.id);
      } finally {
        markRefreshing(false);
        button.classList.remove("vrm-is-busy");
      }
    });
    return button;
  }

  function createCollapseButton(section) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vrm-collapse-button";
    button.title = state.missingCollapsed ? "Развернуть список «Не пришли»" : "Свернуть список «Не пришли»";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!state.missingCollapsed));
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 6.1 8 9.9l3.8-3.8 1.1 1.1L8 12.1 3.1 7.2z"></path></svg>';
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.missingCollapsed = !state.missingCollapsed;
      section.classList.toggle("vrm-is-collapsed", state.missingCollapsed);
      button.title = state.missingCollapsed ? "Развернуть список «Не пришли»" : "Свернуть список «Не пришли»";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-expanded", String(!state.missingCollapsed));
      state = await VRMStorage.save(state);
    });
    return button;
  }

  function storedParticipantStatus(name) {
    return activeRoster?.statuses?.[VRMeetups.comparisonKey(name)] || null;
  }

  function participantStatus(name) {
    const status = storedParticipantStatus(name);
    return VRMeetups.statusIsActive(status) ? status : null;
  }

  function statusDescription(status) {
    const typeLabel = status?.type === "vacation" ? "в отпуске" : "отсутствует";
    const period = VRMeetups.formatStatusPeriod(status, true);
    return period ? `${typeLabel}, ${period}` : typeLabel;
  }

  // Готовый «снимок» строки: и рисуется из него, и кладётся в кеш. Поэтому
  // после закрытия и повторного открытия панели строка выглядит точно так же,
  // как до этого, даже пока свежие данные ещё не пришли.
  function rowView(name) {
    const status = participantStatus(name);
    const statusDetails = {
      vacation: { icon: "🌴", label: "в отпуске" },
      absent: { icon: "🚌", label: "отсутствует" }
    }[status?.type];
    // Свой статус важнее: он выставлен руками именно для этой встречи.
    const member = memberForName(name);
    const mattermostIcon = statusDetails ? null : (member && VRMattermost.memberIcon(member));
    const mattermostText = member ? VRMattermost.describe(member) : "";
    const presence = member ? VRMattermost.presence(member) : null;

    let title;
    if (statusDetails) {
      title = `${name} — ${statusDescription(status)}. Нажмите, чтобы изменить статус`;
    } else if (mattermostText) {
      title = `${name} — ${mattermostText} (Mattermost). Нажмите, чтобы задать свой статус`;
    } else {
      title = `${name} — установить статус`;
    }

    return {
      name,
      avatar: statusDetails?.icon || mattermostIcon || VRMeetups.initials(name),
      hasStatus: Boolean(statusDetails || mattermostIcon),
      fromMattermost: Boolean(mattermostIcon),
      ownStatus: Boolean(statusDetails),
      title,
      presence: presence ? presence.short : "",
      presenceTone: presence ? presence.tone : "",
      presenceTitle: mattermostText ? `${name} в Mattermost: ${mattermostText}` : ""
    };
  }

  function applyRowView(button, view) {
    button.classList.toggle("vrm-has-status", Boolean(view.hasStatus));
    button.classList.toggle("vrm-from-mattermost", Boolean(view.fromMattermost));
    button.textContent = view.avatar;
    button.title = view.title;
    button.setAttribute("aria-label", view.title);
    button.setAttribute("aria-pressed", view.ownStatus ? "true" : "false");
  }

  function closeStatusMenu() {
    document.getElementById(STATUS_MENU_ID)?.remove();
    statusMenuAnchor = null;
    if (statusMenuOutsideHandler) {
      document.removeEventListener("pointerdown", statusMenuOutsideHandler, true);
      statusMenuOutsideHandler = null;
    }
  }

  async function saveParticipantStatus(name, status) {
    const rosterIndex = state.rosters.findIndex((roster) => roster.id === activeRoster?.id);
    if (rosterIndex < 0) return;

    const nameKey = VRMeetups.comparisonKey(name);
    const statuses = { ...(state.rosters[rosterIndex].statuses || {}) };
    if (status) statuses[nameKey] = status;
    else delete statuses[nameKey];

    state.rosters[rosterIndex] = { ...state.rosters[rosterIndex], statuses, updatedAt: Date.now() };
    ignoreMutationsUntil = Date.now() + 1000;
    state = await VRMStorage.save(state);
    activeRoster = VRMeetups.rosterById(state.rosters, activeRoster.id);

    document.querySelectorAll(".vrm-missing-avatar").forEach((button) => {
      if (button.dataset.participantKey === nameKey) applyRowView(button, rowView(name));
    });
    updatePresentMarkers();
  }

  function showStatusTimingMenu(anchor, name, type) {
    closeStatusMenu();
    const menu = document.createElement("div");
    menu.id = STATUS_MENU_ID;
    menu.setAttribute("data-vrm-extension", "true");
    menu.setAttribute("role", "menu");
    const typeLabel = type === "vacation" ? "🌴 В отпуске" : "🚌 Отсутствует";
    menu.setAttribute("aria-label", `${typeLabel}: ${name}`);

    const heading = document.createElement("div");
    heading.className = "vrm-status-heading";
    heading.textContent = `${typeLabel} — на какой срок?`;
    menu.append(heading);

    [
      { preset: "forever", icon: "∞", label: "Без срока" },
      { preset: "today", icon: "●", label: "Сегодня" },
      { preset: "tomorrow", icon: "→", label: "Завтра" }
    ].forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "vrm-status-option vrm-timing-option";
      item.setAttribute("role", "menuitem");
      const icon = document.createElement("span");
      icon.className = "vrm-status-icon";
      icon.textContent = option.icon;
      const label = document.createElement("span");
      label.textContent = option.label;
      item.append(icon, label);
      item.addEventListener("click", async () => {
        closeStatusMenu();
        await saveParticipantStatus(name, VRMeetups.statusFromPreset(type, option.preset));
      });
      menu.append(item);
    });

    const separator = document.createElement("div");
    separator.className = "vrm-status-separator";
    const range = document.createElement("div");
    range.className = "vrm-status-range";
    const rangeTitle = document.createElement("div");
    rangeTitle.className = "vrm-status-range-title";
    rangeTitle.textContent = "Период";
    const fromInput = document.createElement("input");
    fromInput.type = "date";
    fromInput.setAttribute("aria-label", "Дата начала");
    const untilInput = document.createElement("input");
    untilInput.type = "date";
    untilInput.setAttribute("aria-label", "Дата окончания");
    const storedStatus = storedParticipantStatus(name);
    const today = VRMeetups.localDateISO();
    fromInput.value = storedStatus?.type === type && storedStatus.from ? storedStatus.from : today;
    untilInput.value = storedStatus?.type === type && storedStatus.until ? storedStatus.until : today;
    const rangeFields = document.createElement("div");
    rangeFields.className = "vrm-status-range-fields";
    const fromField = document.createElement("label");
    fromField.className = "vrm-status-date-field";
    const fromLabel = document.createElement("span");
    fromLabel.textContent = "С";
    fromField.append(fromLabel, fromInput);
    const untilField = document.createElement("label");
    untilField.className = "vrm-status-date-field";
    const untilLabel = document.createElement("span");
    untilLabel.textContent = "До";
    untilField.append(untilLabel, untilInput);
    rangeFields.append(fromField, untilField);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "vrm-status-range-apply";
    apply.textContent = "Применить период";
    apply.addEventListener("click", async () => {
      const status = VRMeetups.statusFromPreset(type, "range", fromInput.value, untilInput.value);
      if (!status) {
        untilInput.setCustomValidity("Дата окончания должна быть не раньше даты начала");
        untilInput.reportValidity();
        return;
      }
      untilInput.setCustomValidity("");
      closeStatusMenu();
      await saveParticipantStatus(name, status);
    });
    range.append(rangeTitle, rangeFields, apply);
    menu.append(separator, range);
    placeStatusMenu(menu, anchor, ".vrm-timing-option");
  }

  function placeStatusMenu(menu, anchor, focusSelector) {
    document.documentElement.append(menu);
    statusMenuAnchor = anchor;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8));
    const roomBelow = window.innerHeight - anchorRect.bottom;
    const top = roomBelow >= menuRect.height + 8
      ? anchorRect.bottom + 6
      : Math.max(8, anchorRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector(focusSelector)?.focus();

    statusMenuOutsideHandler = (event) => {
      if (!menu.contains(event.target) && event.target !== anchor) closeStatusMenu();
    };
    setTimeout(() => {
      if (document.getElementById(STATUS_MENU_ID) === menu && statusMenuOutsideHandler) {
        document.addEventListener("pointerdown", statusMenuOutsideHandler, true);
      }
    }, 0);
  }

  function availableAliasNames() {
    const claimedKeys = VRMeetups.rosterMatchKeys(activeRoster);
    return Array.from(lastActualNames.entries())
      .filter(([nameKey]) => !claimedKeys.has(nameKey) &&
        !Array.from(claimedKeys).some((key) => VRMeetups.namesMatch(key, nameKey)))
      .map(([, displayName]) => displayName);
  }

  async function saveParticipantAlias(expectedName, aliasName) {
    const rosterIndex = state.rosters.findIndex((roster) => roster.id === activeRoster?.id);
    if (rosterIndex < 0) return;

    const expectedKey = VRMeetups.comparisonKey(expectedName);
    const aliases = { ...(state.rosters[rosterIndex].aliases || {}) };
    const existingAliases = [...(aliases[expectedKey] || [])];
    if (!existingAliases.some((item) => VRMeetups.comparisonKey(item) === VRMeetups.comparisonKey(aliasName))) {
      existingAliases.push(aliasName);
    }
    aliases[expectedKey] = existingAliases;

    state.rosters[rosterIndex] = { ...state.rosters[rosterIndex], aliases, updatedAt: Date.now() };
    ignoreMutationsUntil = Date.now() + 1000;
    state = await VRMStorage.save(state);
    activeRoster = VRMeetups.rosterById(state.rosters, activeRoster.id);
    closeStatusMenu();
    await scanParticipants(activeRoster.id);
  }

  function showAliasMenu(anchor, expectedName) {
    closeStatusMenu();
    const menu = document.createElement("div");
    menu.id = STATUS_MENU_ID;
    menu.setAttribute("data-vrm-extension", "true");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Псевдоним для ${expectedName}`);

    const heading = document.createElement("div");
    heading.className = "vrm-status-heading";
    heading.textContent = `Кто является «${expectedName}»?`;
    menu.append(heading);

    const candidates = availableAliasNames();
    if (!candidates.length) {
      const empty = document.createElement("div");
      empty.className = "vrm-status-empty";
      empty.textContent = "В комнате нет пользователей, не сопоставленных со списком.";
      menu.append(empty);
    } else {
      candidates.forEach((candidate) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "vrm-status-option vrm-alias-option";
        item.setAttribute("role", "menuitem");
        const icon = document.createElement("span");
        icon.className = "vrm-status-icon";
        icon.textContent = "👤";
        const label = document.createElement("span");
        label.textContent = candidate;
        item.append(icon, label);
        item.addEventListener("click", () => saveParticipantAlias(expectedName, candidate));
        menu.append(item);
      });
    }

    placeStatusMenu(menu, anchor, ".vrm-alias-option");
  }

  function showStatusMenu(anchor, name) {
    closeStatusMenu();
    const menu = document.createElement("div");
    menu.id = STATUS_MENU_ID;
    menu.setAttribute("data-vrm-extension", "true");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Статус: ${name}`);

    const currentStatus = storedParticipantStatus(name);
    const options = [
      { value: null, icon: "●", label: "Без статуса" },
      { value: "vacation", icon: "🌴", label: "В отпуске" },
      { value: "absent", icon: "🚌", label: "Отсутствует" }
    ];
    options.forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "vrm-status-option";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(
        option.value === null ? !currentStatus : currentStatus?.type === option.value
      ));
      const icon = document.createElement("span");
      icon.className = "vrm-status-icon";
      icon.textContent = option.icon;
      const label = document.createElement("span");
      label.textContent = option.label;
      item.append(icon, label);
      if (currentStatus?.type === option.value) {
        const period = document.createElement("span");
        period.className = "vrm-status-period";
        period.textContent = VRMeetups.formatStatusPeriod(currentStatus);
        period.title = VRMeetups.formatStatusPeriod(currentStatus, true);
        item.append(period);
      }
      item.addEventListener("click", async () => {
        if (option.value === null) {
          closeStatusMenu();
          await saveParticipantStatus(name, null);
        } else {
          showStatusTimingMenu(anchor, name, option.value);
        }
      });
      menu.append(item);
    });

    const separator = document.createElement("div");
    separator.className = "vrm-status-separator";
    const aliasButton = document.createElement("button");
    aliasButton.type = "button";
    aliasButton.className = "vrm-status-option";
    aliasButton.setAttribute("role", "menuitem");
    const aliasIcon = document.createElement("span");
    aliasIcon.className = "vrm-status-icon";
    aliasIcon.textContent = "🔗";
    const aliasLabel = document.createElement("span");
    const candidatesCount = availableAliasNames().length;
    aliasLabel.textContent = candidatesCount
      ? `Выбрать псевдоним (${candidatesCount})`
      : "Выбрать псевдоним";
    aliasButton.append(aliasIcon, aliasLabel);
    aliasButton.addEventListener("click", () => showAliasMenu(anchor, name));
    menu.append(separator, aliasButton);

    placeStatusMenu(menu, anchor, '[aria-checked="true"]');
  }

  // Для этой встречи список ещё не выбран: вместо чужих данных показываем,
  // что выбрать, прямо в панели участников.
  function renderPrompt(panel) {
    const signature = VRMeetups.missingSignature([], {
      prompt: "1",
      rosters: state.rosters.length,
      hint: editorHint
    });
    const existing = document.getElementById(MISSING_ID);
    if (existing && existing.parentElement === panel.listContainer && signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    closeStatusMenu();
    existing?.remove();

    const section = document.createElement("section");
    section.id = MISSING_ID;
    section.className = "vrm-is-prompt";
    section.setAttribute("data-vrm-extension", "true");

    const header = document.createElement("div");
    header.className = "vrm-missing-header";
    const label = document.createElement("span");
    label.textContent = "Список не выбран";
    const actions = document.createElement("div");
    actions.className = "vrm-header-actions";
    actions.append(createGearButton());
    header.append(label, actions);

    const body = document.createElement("div");
    body.className = "vrm-missing-body vrm-prompt-body";
    const text = document.createElement("p");
    text.className = "vrm-prompt-text";
    text.textContent = state.rosters.length
      ? "Выберите, кого ждём на этой встрече — список запомнится для неё."
      : "Создайте список тех, кого ждём на этой встрече.";
    // Одна кнопка: создание нового списка — последний пункт того же меню,
    // а когда списков ещё нет, она сразу открывает редактор.
    const buttons = document.createElement("div");
    buttons.className = "vrm-prompt-actions";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "vrm-prompt-button";
    if (state.rosters.length) {
      action.textContent = "Выбрать список ▾";
      action.setAttribute("aria-haspopup", "menu");
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleRosterMenu(action);
      });
    } else {
      action.textContent = "Создать список";
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openEditor({ blank: true });
      });
    }
    buttons.append(action);

    body.append(text, buttons);
    if (editorHint) body.append(createEditorHint());
    const delimiter = document.createElement("div");
    delimiter.className = "vrm-missing-delimiter";
    section.append(header, body, delimiter);
    panel.listContainer.insertBefore(section, panel.scroller);
  }

  // rows — готовые «снимки» строк: свежие после проверки или взятые из кеша,
  // когда панель только что открылась и проверка ещё идёт.
  function renderResult(panel, rows, { expected, stale = false } = {}) {
    if (!activeRoster) {
      document.getElementById(MISSING_ID)?.remove();
      lastRenderSignature = "";
      return;
    }

    const total = Number.isFinite(expected) ? expected : activeRoster.participants.length;
    const signature = VRMeetups.missingSignature(
      rows.map((view) => ({ name: view.name, icon: view.avatar, presence: view.presence })),
      {
        count: `${rows.length}/${total}`,
        roster: activeRoster.name,
        collapsed: state.missingCollapsed === true,
        notice: mmNotice,
        hint: editorHint,
        stale
      }
    );
    const existing = document.getElementById(MISSING_ID);
    // Пока показывать нечего нового, DOM не трогаем: иначе раздел мигает
    // при каждой проверке и при обновлении статусов.
    if (existing && existing.parentElement === panel.listContainer && signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    closeStatusMenu();
    existing?.remove();

    const section = document.createElement("section");
    section.id = MISSING_ID;
    section.setAttribute("data-vrm-extension", "true");

    const delimiter = document.createElement("div");
    delimiter.className = "vrm-missing-delimiter";

    const header = document.createElement("div");
    header.className = "vrm-missing-header";
    const label = document.createElement("span");
    label.textContent = "Не пришли";
    const count = document.createElement("span");
    count.className = "vrm-missing-count";
    count.textContent = `${rows.length}/${total}`;
    // Отдельного значка обновления в шапке нет: пока идёт проверка, крутится
    // сама кнопка обновления слева от шестерёнки.
    const rosterLabel = createRosterButton();

    const actions = document.createElement("div");
    actions.className = "vrm-header-actions";
    if (VRMattermost.isMattermost(activeRoster)) actions.append(createMattermostButton());
    actions.append(createGearButton());
    header.append(createCollapseButton(section), label, count, rosterLabel, actions);
    section.append(header);
    if (editorHint) section.append(createEditorHint());

    const body = document.createElement("div");
    body.className = "vrm-missing-body";
    section.append(body);
    section.classList.toggle("vrm-is-collapsed", state.missingCollapsed);
    section.classList.toggle("vrm-is-stale", stale === true);

    if (!rows.length) {
      const allPresent = document.createElement("div");
      allPresent.className = "vrm-all-present";
      allPresent.textContent = "Все ожидаемые участники на месте";
      body.append(allPresent);
    } else {
      rows.forEach((view) => {
        const name = view.name;
        const row = document.createElement("div");
        row.className = "vrm-missing-row";
        const avatar = document.createElement("button");
        avatar.type = "button";
        avatar.className = "vrm-missing-avatar";
        avatar.dataset.participantKey = VRMeetups.comparisonKey(name);
        avatar.setAttribute("aria-haspopup", "menu");
        applyRowView(avatar, view);
        avatar.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          showStatusMenu(avatar, name);
        });
        const person = document.createElement("span");
        person.className = "vrm-missing-name";
        person.textContent = name;
        person.title = `${name} — отсутствует`;
        row.append(avatar, person);

        // Из Mattermost видно, человек вообще у компьютера или уже ушёл.
        if (view.presence) {
          const badge = document.createElement("span");
          badge.className = `vrm-presence vrm-presence-${view.presenceTone}`;
          badge.textContent = view.presence;
          badge.title = view.presenceTitle || view.presence;
          row.append(badge);
        }
        body.append(row);
      });
    }

    // Разделитель снизу: блок стоит над списком и отделяется от него.
    section.append(delimiter);

    // Блок закреплён над прокручиваемым списком, а не внутри него: до него не
    // нужно листать, виртуализация VirtualRoom его не выкидывает, и его
    // перерисовка больше не меняет высоту прокручиваемой области.
    panel.listContainer.insertBefore(section, panel.scroller);
  }

  // Редактор списков живёт в боковой панели расширения: своего окна на
  // странице больше нет.
  async function openEditor(options) {
    closeStatusMenu();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "VRM_OPEN_EDITOR", ...options });
    } catch (_error) {
      response = null;
    }
    if (response?.ok && !response.needsClick) return;

    editorHint = "Откройте панель расширения по значку — редактор уже готов.";
    redrawBlock();
    clearTimeout(editorHintTimer);
    editorHintTimer = setTimeout(() => {
      editorHint = "";
      redrawBlock();
    }, 15000);
  }

  function createEditorHint() {
    const hint = document.createElement("div");
    hint.className = "vrm-editor-hint";
    hint.textContent = editorHint;
    return hint;
  }

  function redrawBlock() {
    const panel = findPanel();
    if (!panel) return;
    lastRenderSignature = "";
    if (activeRoster) showRememberedResult();
    else renderPrompt(panel);
  }


  async function scanParticipants(preferredRosterId) {
    if (scanning) return { ok: false, message: "Проверка уже выполняется. Подождите несколько секунд." };
    scanning = true;
    try {
      await loadActiveRoster(preferredRosterId);
      const panel = findPanel();
      if (!panel) {
        return { ok: false, message: "Откройте панель «Участники» в VirtualRoom и повторите проверку." };
      }
      if (!activeRoster) {
        renderPrompt(panel);
        return {
          ok: false,
          message: state.rosters.length
            ? "Выберите список для этой встречи — в панели участников или здесь."
            : "Создайте список ожидаемых участников."
        };
      }

      // Пока идёт проверка, показанный блок остаётся на месте и лишь помечается
      // как обновляющийся: прятать его нельзя, он и так самый нужный.
      markRefreshing(true);
      // Состав из Mattermost подтягивается до сравнения: список мог измениться.
      await refreshMattermost(false);
      const actualNames = await collectAllNames(panel.scroller);
      lastActualNames = actualNames;
      const actualNameKeys = new Set(actualNames.keys());
      const missing = activeRoster.participants.filter(
        (name) => !VRMeetups.participantIsPresent(activeRoster, name, actualNameKeys)
      );
      const rows = missing.map(rowView);
      renderResult(panel, rows, { expected: activeRoster.participants.length });
      rememberResult(rows);
      updatePresentMarkers();
      ignoreMutationsUntil = Date.now() + 1000;
      return {
        ok: true,
        rosterId: activeRoster.id,
        rosterName: activeRoster.name,
        expected: activeRoster.participants.length,
        presentExpected: activeRoster.participants.length - missing.length,
        actual: Array.from(actualNames.values()),
        missing
      };
    } finally {
      scanning = false;
      markRefreshing(false);
    }
  }

  // Автопроверка ждёт, пока человек отпустит список: сама она прокручивает
  // панель, и делать это под рукой пользователя нельзя.
  function scheduleAutoScan() {
    if (!activeRoster || scanning || Date.now() < ignoreMutationsUntil) return;
    if (!autoScanWaitingSince) autoScanWaitingSince = Date.now();
    clearTimeout(autoScanTimer);
    autoScanTimer = setTimeout(() => {
      if (scanning || Date.now() < ignoreMutationsUntil) return;
      const defer = VRMeetups.shouldDeferScan({
        now: Date.now(),
        lastUserScrollAt,
        hovered: panelHovered,
        waitingSince: autoScanWaitingSince
      });
      if (defer) {
        autoScanTimer = setTimeout(scheduleAutoScan, 500);
        return;
      }
      autoScanWaitingSince = 0;
      scanParticipants();
    }, AUTO_SCAN_DELAY);
  }

  // Панель пересоздаётся при переоткрытии, поэтому слушатели навешиваются
  // на найденный скроллер один раз и обновляются, если узел заменился.
  function watchUserActivity() {
    const panel = findPanel();
    if (!panel || watchedScroller === panel.scroller) return;

    watchedScroller = panel.scroller;
    panel.scroller.addEventListener("scroll", () => {
      if (!programmaticScroll) lastUserScrollAt = Date.now();
    }, { passive: true });
    panel.listContainer.addEventListener("pointerenter", () => { panelHovered = true; });
    panel.listContainer.addEventListener("pointerleave", () => { panelHovered = false; });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VRM_SCAN_PARTICIPANTS") {
      scanParticipants(message.rosterId)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    // Список, выбранный или созданный в окне расширения, сразу становится
    // списком этой встречи — но только если страница и правда комната.
    if (message?.type === "VRM_BIND_ROSTER") {
      loadActiveRoster()
        .then(async () => {
          if (!findPanel()) return { ok: false, message: "Панель участников не открыта." };
          if (!(await bindRosterToRoom(message.rosterId))) {
            return { ok: false, message: "Список не найден." };
          }
          return scanParticipants(activeRoster.id);
        })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    const watched = ["rosters", "roomAssignments", "titleAssignments", "selectedRosterId", "highlightPresent", "showMattermostStatuses"];
    if (areaName !== "local" || !watched.some((key) => changes[key])) return;
    loadActiveRoster().then(() => {
      updatePresentMarkers();
      // Без привязки на месте блока остаётся приглашение выбрать список.
      if (!activeRoster) showRememberedResult();
      else scheduleAutoScan();
    });
  });

  const observer = new MutationObserver((mutations) => {
    if (scanning || Date.now() < ignoreMutationsUntil) return;
    const participantsChanged = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some((node) => {
        if (!(node instanceof Element) || node.closest?.("[data-vrm-extension]")) return false;
        return node.matches?.(NAME_SELECTOR) || node.querySelector?.(NAME_SELECTOR) ||
          node.matches?.(LIST_CONTAINER_SELECTOR) || node.querySelector?.(LIST_CONTAINER_SELECTOR);
      })
    );
    if (participantsChanged) {
      watchUserActivity();
      // Панель могли только что открыть: блок возвращается из кеша сразу,
      // не дожидаясь проверки.
      showRememberedResult();
      updatePresentMarkers();
      scheduleAutoScan();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  Promise.all([loadActiveRoster(), VRMStorage.loadResults()]).then(([, results]) => {
    resultCache = results;
    watchUserActivity();
    showRememberedResult();
    updatePresentMarkers();
    if (activeRoster && findPanel()) scheduleAutoScan();
    scheduleMidnightRefresh();
    scheduleMattermostRefresh();
  });
})();
