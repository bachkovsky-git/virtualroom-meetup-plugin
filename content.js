(function () {
  "use strict";

  const NAME_SELECTOR = '[class*="ParticipantName"]';
  const LIST_CONTAINER_SELECTOR = '[class*="ParticipantListContainer"]';
  const SCROLLER_SELECTOR = '.participant-list, [class*="GridScrollContainer"]';
  const MISSING_ID = "vrm-attendance-missing";
  const PICKER_ID = "vrm-roster-picker";
  const STATUS_MENU_ID = "vrm-attendance-status-menu";
  const GEAR_PATH = "m14.54 7.37 1.065-.58a.755.755 0 0 0 .366-.873c-.366-1.356-1.132-2.583-2.13-3.584-.266-.226-.666-.29-.965-.13l-1.065.614a4.5 4.5 0 0 0-1.098-.613V1.009c0-.355-.233-.646-.6-.743a8.5 8.5 0 0 0-4.226 0c-.366.097-.6.388-.6.743v1.195a4.5 4.5 0 0 0-1.098.613l-1.065-.613c-.3-.162-.699-.097-.965.129C1.161 3.334.395 4.561.03 5.917c-.1.355.067.71.366.872l1.065.581c-.033.226-.033.42-.033.646 0 .194 0 .388.033.581l-1.065.614a.755.755 0 0 0-.366.872c.366 1.356 1.132 2.583 2.13 3.584.266.226.666.29.965.13l1.065-.614c.333.258.7.452 1.099.613v1.195c0 .355.233.646.599.743a8.5 8.5 0 0 0 4.226 0c.367-.097.6-.388.6-.743v-1.195c.399-.161.765-.355 1.098-.613l1.065.613c.3.162.699.097.965-.129.998-1.001 1.764-2.228 2.13-3.584a.755.755 0 0 0-.366-.872l-1.065-.614a7.6 7.6 0 0 0 0-1.227m-1.764 2.067 1.464.807c-.266.678-.632 1.324-1.131 1.873l-1.465-.807c-1.065.872-1.198.968-2.53 1.42v1.647a6.4 6.4 0 0 1-2.229 0v-1.646c-1.331-.453-1.498-.55-2.53-1.421l-1.464.807c-.499-.549-.865-1.195-1.131-1.873l1.464-.807c-.266-1.356-.266-1.518 0-2.874L1.76 5.756c.266-.678.632-1.324 1.131-1.873l1.465.807c1.065-.872 1.198-.969 2.53-1.42V1.622a6.4 6.4 0 0 1 2.229 0v1.646c1.331.452 1.498.55 2.53 1.421l1.464-.807c.499.549.865 1.195 1.131 1.873l-1.464.807c.266 1.356.266 1.518 0 2.874m-4.76-4.553c-1.763 0-3.194 1.42-3.194 3.1 0 1.711 1.43 3.1 3.195 3.1 1.73 0 3.195-1.389 3.195-3.1 0-1.68-1.465-3.1-3.195-3.1m0 4.65c-.898 0-1.597-.678-1.597-1.55 0-.84.699-1.55 1.598-1.55.865 0 1.597.71 1.597 1.55 0 .872-.732 1.55-1.597 1.55";
  const AUTO_SCAN_DELAY = 1200;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  let state = {
    rosters: [],
    roomAssignments: {},
    selectedRosterId: null,
    highlightPresent: true,
    missingCollapsed: false
  };
  let activeRoster = null;
  let scanning = false;
  let autoScanTimer = null;
  let ignoreMutationsUntil = 0;
  let statusMenuOutsideHandler = null;
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

  function currentRoomKey() {
    return VRMeetups.roomKey(location.href);
  }

  async function loadActiveRoster(preferredRosterId) {
    state = await VRMStorage.load();
    activeRoster = VRMeetups.rosterById(state.rosters, preferredRosterId) ||
      VRMeetups.rosterForRoom(state, currentRoomKey());
    return activeRoster;
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
    if (!panel || !activeRoster) return false;
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

  function createGearButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vrm-settings-button";
    button.title = "Настроить список ожидаемых участников";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="${GEAR_PATH}" clip-rule="evenodd"></path></svg>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showRosterPicker();
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
      button.classList.add("vrm-is-busy");
      await refreshMattermost(true);
      await scanParticipants(activeRoster?.id);
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
    // Значок кручения показывается, пока данные из прошлой проверки: сам блок
    // при этом не прячется.
    const refreshing = document.createElement("span");
    refreshing.className = "vrm-refreshing";
    refreshing.textContent = "⟳";
    refreshing.title = "Показаны данные прошлой проверки, идёт обновление";
    const rosterLabel = document.createElement("span");
    rosterLabel.className = "vrm-roster-name";
    rosterLabel.textContent = activeRoster.name;
    rosterLabel.title = VRMattermost.isMattermost(activeRoster)
      ? `Список «${activeRoster.name}» — состав из канала Mattermost «${activeRoster.source.channelDisplayName || activeRoster.source.channelName}»`
      : `Выбран список: ${activeRoster.name}`;

    const actions = document.createElement("div");
    actions.className = "vrm-header-actions";
    if (VRMattermost.isMattermost(activeRoster)) actions.append(createMattermostButton());
    actions.append(createGearButton());
    header.append(createCollapseButton(section), label, count, refreshing, rosterLabel, actions);
    section.append(header);

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

  function closeRosterPicker() {
    document.getElementById(PICKER_ID)?.remove();
  }

  function showRosterPicker() {
    closeRosterPicker();
    const overlay = document.createElement("div");
    overlay.id = PICKER_ID;
    overlay.setAttribute("data-vrm-extension", "true");
    const dialog = document.createElement("div");
    dialog.className = "vrm-picker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.className = "vrm-picker-title";
    title.textContent = "Список ожидаемых участников";
    const description = document.createElement("p");
    description.className = "vrm-picker-description";
    description.textContent = "Выберите список, измените его состав или создайте новый.";

    const select = document.createElement("select");
    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "vrm-picker-new";
    newButton.textContent = "+ Новый";

    const selectLabel = document.createElement("label");
    selectLabel.className = "vrm-picker-label";
    selectLabel.textContent = "Готовый список";
    const selectWrap = document.createElement("div");
    selectWrap.className = "vrm-picker-field-grow";
    selectWrap.append(selectLabel, select);
    const selectRow = document.createElement("div");
    selectRow.className = "vrm-picker-field-row";
    selectRow.append(selectWrap, newButton);

    const nameLabel = document.createElement("label");
    nameLabel.className = "vrm-picker-label";
    nameLabel.textContent = "Название списка";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.placeholder = "Например, продуктовый митап";

    const peopleLabel = document.createElement("label");
    peopleLabel.className = "vrm-picker-label";
    peopleLabel.textContent = "Ожидаемые участники";
    const peopleInput = document.createElement("textarea");
    peopleInput.placeholder = "Иван Иванов\nМария Петрова";
    peopleInput.spellcheck = false;
    const hint = document.createElement("p");
    hint.className = "vrm-picker-hint";
    hint.textContent = "По одному человеку на строку. Можно дописать людей в текущий список.";

    const sourceBox = document.createElement("div");
    sourceBox.className = "vrm-picker-source";
    const sourceText = document.createElement("span");
    const sourceSync = document.createElement("button");
    sourceSync.type = "button";
    sourceSync.className = "vrm-picker-source-sync";
    sourceSync.textContent = "Обновить";
    const sourceDetach = document.createElement("button");
    sourceDetach.type = "button";
    sourceDetach.className = "vrm-picker-source-detach";
    sourceDetach.textContent = "Отвязать";
    sourceBox.append(sourceText, sourceSync, sourceDetach);

    const aliasesLabel = document.createElement("div");
    aliasesLabel.className = "vrm-picker-label vrm-picker-aliases-label";
    aliasesLabel.textContent = "Сохранённые псевдонимы";
    const aliasesList = document.createElement("div");
    aliasesList.className = "vrm-picker-aliases";

    let draftId = null;
    let draftAliases = {};
    let draftSource = null;

    function renderSource() {
      const linked = draftSource?.type === "mattermost";
      sourceBox.hidden = !linked;
      peopleInput.readOnly = linked;
      peopleInput.classList.toggle("vrm-is-readonly", linked);
      hint.textContent = linked
        ? "Состав приходит из Mattermost и обновляется автоматически. Правки здесь не сохранятся."
        : "По одному человеку на строку. Можно дописать людей в текущий список.";
      if (linked) {
        const channel = draftSource.channelDisplayName || draftSource.channelName;
        sourceText.textContent = `Канал Mattermost: ${channel}`;
        sourceText.title = `${draftSource.baseUrl} — ${channel}`;
      }
    }

    sourceDetach.addEventListener("click", () => {
      draftSource = null;
      renderSource();
      peopleInput.focus();
    });

    sourceSync.addEventListener("click", async () => {
      if (!draftSource) return;
      sourceSync.disabled = true;
      sourceSync.textContent = "Обновляю…";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "VRM_MM_SNAPSHOT",
          source: draftSource,
          force: true
        });
        if (!response?.ok) throw new Error(response?.message || "Не удалось получить данные из Mattermost.");
        const merged = VRMattermost.applySnapshot({ aliases: draftAliases }, response.members);
        peopleInput.value = merged.participants.join("\n");
        draftAliases = merged.aliases;
        draftSource = { ...draftSource, syncedAt: response.fetchedAt };
        renderAliases();
        sourceText.textContent = `Канал Mattermost: ${response.channel.displayName} — ${merged.participants.length} чел.`;
      } catch (error) {
        sourceText.textContent = error.message;
      } finally {
        sourceSync.disabled = false;
        sourceSync.textContent = "Обновить";
      }
    });

    function fillSelect(selectedId) {
      select.replaceChildren();
      state.rosters.forEach((roster) => {
        const option = document.createElement("option");
        option.value = roster.id;
        option.textContent = `${roster.name} (${roster.participants.length})`;
        select.append(option);
      });
      select.disabled = !state.rosters.length;
      if (selectedId && VRMeetups.rosterById(state.rosters, selectedId)) select.value = selectedId;
    }

    function editRoster(roster) {
      draftId = roster?.id || VRMStorage.newId();
      nameInput.value = roster?.name || "";
      peopleInput.value = (roster?.participants || []).join("\n");
      draftAliases = Object.fromEntries(
        Object.entries(roster?.aliases || {}).map(([key, values]) => [key, [...values]])
      );
      draftSource = roster?.source ? { ...roster.source } : null;
      renderSource();
      renderAliases();
    }

    function renderAliases() {
      aliasesList.replaceChildren();
      const participantsByKey = new Map(
        VRMeetups.parseExpected(peopleInput.value).map((name) => [VRMeetups.comparisonKey(name), name])
      );
      const rows = Object.entries(draftAliases).flatMap(([expectedKey, aliases]) =>
        aliases.map((alias) => ({ expectedKey, expectedName: participantsByKey.get(expectedKey) || expectedKey, alias }))
      );
      aliasesLabel.hidden = rows.length === 0;
      aliasesList.hidden = rows.length === 0;

      rows.forEach(({ expectedKey, expectedName, alias }) => {
        const row = document.createElement("div");
        row.className = "vrm-picker-alias-row";
        const mapping = document.createElement("span");
        mapping.textContent = `${expectedName} ← ${alias}`;
        mapping.title = mapping.textContent;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "vrm-picker-alias-remove";
        remove.textContent = "×";
        remove.title = `Удалить псевдоним ${alias}`;
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
          draftAliases[expectedKey] = (draftAliases[expectedKey] || []).filter(
            (item) => VRMeetups.comparisonKey(item) !== VRMeetups.comparisonKey(alias)
          );
          if (!draftAliases[expectedKey].length) delete draftAliases[expectedKey];
          renderAliases();
        });
        row.append(mapping, remove);
        aliasesList.append(row);
      });
    }

    fillSelect(activeRoster?.id);
    editRoster(activeRoster);

    const binding = document.createElement("label");
    binding.className = "vrm-picker-bind";
    const bindCheckbox = document.createElement("input");
    bindCheckbox.type = "checkbox";
    bindCheckbox.checked = Boolean(activeRoster && state.roomAssignments[currentRoomKey()] === activeRoster.id);
    const bindingText = document.createElement("span");
    bindingText.textContent = "Запомнить выбор для этой комнаты";
    binding.append(bindCheckbox, bindingText);

    const highlight = document.createElement("label");
    highlight.className = "vrm-picker-bind";
    const highlightCheckbox = document.createElement("input");
    highlightCheckbox.type = "checkbox";
    highlightCheckbox.checked = state.highlightPresent !== false;
    const highlightText = document.createElement("span");
    highlightText.textContent = "Подсвечивать пришедших пользователей";
    highlight.append(highlightCheckbox, highlightText);
    const settings = document.createElement("div");
    settings.className = "vrm-picker-settings";
    settings.append(binding, highlight);

    const actions = document.createElement("div");
    actions.className = "vrm-picker-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "vrm-picker-cancel";
    cancel.textContent = "Отмена";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "vrm-picker-apply";
    apply.textContent = "Сохранить и выбрать";
    actions.append(cancel, apply);
    dialog.append(
      title,
      description,
      selectRow,
      nameLabel,
      nameInput,
      peopleLabel,
      peopleInput,
      hint,
      sourceBox,
      aliasesLabel,
      aliasesList,
      settings,
      actions
    );
    overlay.append(dialog);
    document.documentElement.append(overlay);

    cancel.addEventListener("click", closeRosterPicker);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeRosterPicker();
    });
    select.addEventListener("change", () => {
      const selected = VRMeetups.rosterById(state.rosters, select.value);
      editRoster(selected);
      bindCheckbox.checked = Boolean(selected && state.roomAssignments[currentRoomKey()] === selected.id);
    });
    newButton.addEventListener("click", () => {
      select.selectedIndex = -1;
      editRoster(null);
      bindCheckbox.checked = true;
      nameInput.focus();
    });
    peopleInput.addEventListener("input", renderAliases);
    apply.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const participants = VRMeetups.parseExpected(peopleInput.value);
      if (!name) {
        nameInput.focus();
        nameInput.setCustomValidity("Введите название списка");
        nameInput.reportValidity();
        return;
      }
      nameInput.setCustomValidity("");
      if (!participants.length) {
        peopleInput.focus();
        peopleInput.setCustomValidity("Добавьте хотя бы одного участника");
        peopleInput.reportValidity();
        return;
      }
      peopleInput.setCustomValidity("");

      const existingIndex = state.rosters.findIndex((roster) => roster.id === draftId);
      const existing = state.rosters[existingIndex];
      const savedRoster = {
        id: draftId || VRMStorage.newId(),
        name,
        participants,
        statuses: existing?.statuses || {},
        aliases: draftAliases,
        source: draftSource,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      if (existingIndex >= 0) state.rosters[existingIndex] = savedRoster;
      else state.rosters.push(savedRoster);

      appliedSnapshotKey = "";
      state.selectedRosterId = savedRoster.id;
      state.highlightPresent = highlightCheckbox.checked;
      if (bindCheckbox.checked) state.roomAssignments[currentRoomKey()] = savedRoster.id;
      else delete state.roomAssignments[currentRoomKey()];
      state = await VRMStorage.save(state);
      activeRoster = savedRoster;
      closeRosterPicker();
      await scanParticipants(savedRoster.id);
    });
  }

  async function scanParticipants(preferredRosterId) {
    if (scanning) return { ok: false, message: "Проверка уже выполняется. Подождите несколько секунд." };
    scanning = true;
    try {
      await loadActiveRoster(preferredRosterId);
      if (!activeRoster) {
        return { ok: false, message: "Сначала создайте список ожидаемых участников в расширении." };
      }

      const panel = findPanel();
      if (!panel) {
        return { ok: false, message: "Откройте панель «Участники» в VirtualRoom и повторите проверку." };
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
    if (message?.type !== "VRM_SCAN_PARTICIPANTS") return undefined;
    scanParticipants(message.rosterId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    const watched = ["rosters", "roomAssignments", "selectedRosterId", "highlightPresent", "showMattermostStatuses"];
    if (areaName !== "local" || !watched.some((key) => changes[key])) return;
    loadActiveRoster().then(() => {
      updatePresentMarkers();
      if (!activeRoster) {
        document.getElementById(MISSING_ID)?.remove();
      } else {
        scheduleAutoScan();
      }
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
