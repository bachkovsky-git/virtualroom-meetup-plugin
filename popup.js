(function () {
  "use strict";

  const rosterSelect = document.getElementById("roster-select");
  const rosterName = document.getElementById("roster-name");
  const rosterText = document.getElementById("roster");
  const simpleEditor = document.getElementById("simple-editor");
  const detailedEditor = document.getElementById("detailed-editor");
  const detailedToggle = document.getElementById("detailed-editor-toggle");
  const participantRows = document.getElementById("participant-rows");
  const addParticipantButton = document.getElementById("add-participant");
  const rosterCount = document.getElementById("roster-count");
  const aliasesBlock = document.getElementById("aliases-block");
  const aliasesList = document.getElementById("aliases-list");
  const highlightPresent = document.getElementById("highlight-present");
  const newButton = document.getElementById("new-roster");
  const deleteButton = document.getElementById("delete-roster");
  const saveButton = document.getElementById("save");
  const statusBox = document.getElementById("status");
  const modeMattermost = document.getElementById("mode-mattermost");
  const modeManual = document.getElementById("mode-manual");
  const manualFields = document.getElementById("manual-fields");
  const rosterLabel = document.getElementById("roster-label");
  const rosterHint = document.getElementById("roster-hint");
  const mmSession = document.getElementById("mm-session");
  const mmSessionText = document.getElementById("mm-session-text");
  const mmForget = document.getElementById("mm-forget");
  const mmFields = document.getElementById("mm-fields");
  const mmUrl = document.getElementById("mm-url");
  const mmConnect = document.getElementById("mm-connect");
  const mmTeam = document.getElementById("mm-team");
  const mmChannel = document.getElementById("mm-channel");
  const mmInfo = document.getElementById("mm-info");
  const mmLoading = document.getElementById("mm-loading");
  const mmLoadingText = document.getElementById("mm-loading-text");
  const mmStatuses = document.getElementById("mm-statuses");

  let state = {
    rosters: [],
    roomAssignments: {},
    titleAssignments: {},
    selectedRosterId: null,
    highlightPresent: true,
    detailedEditor: false
  };
  let currentRoomKey = "";
  let currentTitleKey = "";
  let currentTab = null;
  let currentMeetingTitle = "";
  // Предзаполненное название не считается правкой пользователя.
  let prefilledName = "";
  let draftId = null;
  let detailedRows = [];
  let draftSource = null;
  let mmTeams = [];
  let mmChannels = [];
  let mmLists = { teams: [], channels: {} };
  let draftMode = "mattermost";
  // Выбор канала не выбрасывается при уходе в ручной режим: пользователь
  // может передумать, и возвращаться к пустым спискам неприятно.
  let stashedSource = null;
  // Единый источник псевдонимов в панели: и подробный редактор, и блок
  // «Сохранённые псевдонимы» правят эту карту.
  let draftAliases = {};
  let mmListsReady = false;

  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.className = `status visible ${kind}`;
  }

  function setBusy(busy) {
    newButton.disabled = busy;
    saveButton.disabled = busy;
    addParticipantButton.disabled = busy;
    deleteButton.disabled = busy || !VRMeetups.rosterById(state.rosters, draftId);
    saveButton.textContent = busy ? "Сохраняю…" : "Сохранить";
  }

  // Редактор открывается отдельным окном, поэтому «активная вкладка текущего
  // окна» — это он сам. Контекст встречи присылает страница через фон, а запрос
  // вкладки остаётся запасным путём.
  async function getMeetingContext() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "VRM_MEETING_CONTEXT" });
      const meeting = response?.meeting;
      if (meeting?.tabId) {
        return {
          tabId: meeting.tabId,
          roomKey: meeting.roomKey || "",
          titleKey: meeting.titleKey || "",
          title: meeting.title || ""
        };
      }
    } catch (_error) {
      // Фон мог не ответить — ниже запасной путь.
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || String(tab.url || "").startsWith("chrome-extension://")) return null;
    return {
      tabId: tab.id,
      roomKey: VRMeetups.roomKey(tab.url || ""),
      titleKey: VRMeetups.roomTitleKey(tab.title || ""),
      title: VRMeetups.roomTitle(tab.title || "")
    };
  }

  // --- Mattermost ---------------------------------------------------------

  function mmSay(message, kind) {
    mmInfo.textContent = message;
    mmInfo.className = kind ? `hint mm-${kind}` : "hint";
  }

  // Видимый признак работы: смена канала тянет состав, и без индикатора
  // непонятно, происходит ли что-то вообще.
  function mmBusy(text) {
    mmLoading.hidden = !text;
    if (text) mmLoadingText.textContent = text;
    saveButton.disabled = Boolean(text);
    mmTeam.disabled = Boolean(text) || !mmTeams.length;
    mmChannel.disabled = Boolean(text) || !mmChannels.length;
  }

  async function mmSend(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.message || "Mattermost не ответил.");
    return response;
  }

  function fillOptions(select, items, selectedValue, placeholder) {
    select.replaceChildren();
    if (!items.length) select.add(new Option(placeholder, ""));
    items.forEach((item) => select.add(new Option(item.label, item.value)));
    select.disabled = !items.length;
    if (selectedValue && items.some((item) => item.value === selectedValue)) select.value = selectedValue;
  }

  // Режимы взаимоисключающие, поэтому переключатель прячет один блок целиком
  // и показывает другой — половинчатых состояний в интерфейсе не остаётся.
  function isMattermostMode() {
    return draftMode === "mattermost";
  }

  function detailedActive() {
    return !isMattermostMode() && detailedToggle.checked;
  }

  function applyMode() {
    const mattermost = isMattermostMode();
    modeMattermost.setAttribute("aria-checked", String(mattermost));
    modeManual.setAttribute("aria-checked", String(!mattermost));
    modeMattermost.classList.toggle("is-active", mattermost);
    modeManual.classList.toggle("is-active", !mattermost);
    mmFields.hidden = !mattermost;
    manualFields.hidden = mattermost;

    // В режиме Mattermost состав приходит из канала: поле только для чтения,
    // подсказка про «по одному на строку» здесь не нужна.
    rosterText.readOnly = mattermost;
    rosterText.classList.toggle("readonly", mattermost);
    rosterLabel.textContent = mattermost ? "Состав канала" : "Кого ждём";
    // В режиме канала пояснять нечего: состав и так только для чтения.
    rosterHint.hidden = mattermost;
    rosterHint.textContent = mattermost
      ? ""
      : "По одному человеку на строку. Порядок имени и фамилии не важен.";
    updateRosterCount();

    applyEditorMode();
    renderAliases();
    if (mattermost && draftSource) {
      mmUrl.value = draftSource.baseUrl;
      const synced = draftSource.syncedAt
        ? new Date(draftSource.syncedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "ещё не обновлялся";
      mmSay(`Обновлён: ${synced}.`);
    } else if (mattermost && !mmUrl.value) {
      mmUrl.value = state.mattermostUrl || VRMattermost.DEFAULT_BASE_URL;
    }
  }

  function setMode(mode) {
    if (draftMode === mode) return;
    draftMode = mode;
    if (mode === "manual") {
      // Привязка к каналу откладывается в сторону, а не удаляется: сохранение
      // в ручном режиме всё равно запишет список без источника.
      stashedSource = draftSource;
      draftSource = null;
      mmSay("");
      applyMode();
      return;
    }
    draftSource = draftSource || stashedSource;
    applyMode();
    // Команда и канал уже загружены в этом окне — не дёргаем сеть заново
    // и не сбрасываем выбор.
    if (!mmListsReady) mmPrepare();
  }

  function showTeams(teams, preferredTeamId) {
    mmTeams = teams;
    fillOptions(mmTeam, teams.map((team) => ({ value: team.id, label: team.displayName })), preferredTeamId, "Команды загружаются…");
  }

  function showChannels(channels, preferredChannelId) {
    mmChannels = channels;
    fillOptions(
      mmChannel,
      channels.map((channel) => ({ value: channel.id, label: `${channel.private ? "🔒 " : ""}${channel.displayName}` })),
      preferredChannelId,
      "Каналы загружаются…"
    );
  }

  // Сначала показываем то, что уже знаем: и выбранные ранее значения, и кеш
  // прошлой загрузки. Так выпадающие списки не открываются пустыми.
  function showCachedLists() {
    const teamId = mmTeam.value || draftSource?.teamId || state.lastMattermostTeamId || "";
    const channelId = mmChannel.value || draftSource?.channelId || state.lastMattermostChannelId || "";
    const teams = mmLists.teams.length
      ? mmLists.teams
      : (draftSource?.teamId
        ? [{ id: draftSource.teamId, name: draftSource.teamName, displayName: draftSource.teamName || draftSource.teamId }]
        : []);
    const channels = mmLists.channels[teamId]?.length
      ? mmLists.channels[teamId]
      : (draftSource?.channelId
        ? [{
          id: draftSource.channelId,
          name: draftSource.channelName,
          displayName: draftSource.channelDisplayName || draftSource.channelName,
          private: false
        }]
        : []);
    showTeams(teams, teamId);
    showChannels(channels, channelId);
  }

  async function mmFillTeams(baseUrl, preferredTeamId) {
    const { teams } = await mmSend({ type: "VRM_MM_TEAMS", baseUrl });
    mmLists = await VRMStorage.saveLists({ ...mmLists, teams });
    showTeams(teams, preferredTeamId || mmTeam.value);
    mmListsReady = teams.length > 0;
    if (mmTeam.value) await mmFillChannels(baseUrl, mmTeam.value, draftSource?.channelId || state.lastMattermostChannelId);
  }

  async function mmFillChannels(baseUrl, teamId, preferredChannelId) {
    const { channels } = await mmSend({ type: "VRM_MM_CHANNELS", baseUrl, teamId });
    mmLists = await VRMStorage.saveLists({
      ...mmLists,
      channels: { ...mmLists.channels, [teamId]: channels }
    });
    showChannels(channels, preferredChannelId || mmChannel.value);
  }

  async function mmConnectClick() {
    const baseUrl = VRMattermost.normalizeBaseUrl(mmUrl.value);
    if (!baseUrl) {
      mmSay("Укажите адрес, например https://mattermost.example.com.", "error");
      return;
    }
    // Разрешение на домен запрашивается по клику: без жеста Chrome откажет.
    const granted = await chrome.permissions.request({ origins: [`${VRMattermost.originOf(baseUrl)}/*`] });
    if (!granted) {
      mmSay("Без доступа к этому адресу расширение не сможет читать канал.", "error");
      return;
    }

    mmConnect.disabled = true;
    mmSay("Проверяю подключение…");
    try {
      const { user } = await mmSend({ type: "VRM_MM_CONNECT", baseUrl });
      mmUrl.value = baseUrl;
      state = await VRMStorage.patch({ mattermostUrl: baseUrl });
      mmSay(`Подключено как ${user.name || user.username}. Выберите команду и канал.`, "success");
      await mmFillTeams(baseUrl, draftSource?.teamId);
    } catch (error) {
      mmSay(error.message, "error");
    } finally {
      mmConnect.disabled = false;
    }
  }

  async function mmLoadMembers() {
    const baseUrl = VRMattermost.normalizeBaseUrl(mmUrl.value);
    const team = mmTeams.find((item) => item.id === mmTeam.value);
    const channel = mmChannels.find((item) => item.id === mmChannel.value);
    if (!baseUrl || !team || !channel) {
      mmSay("Выберите команду и канал.", "error");
      return;
    }

    mmBusy("Читаю состав канала…");
    mmSay("");
    try {
      const source = {
        type: "mattermost",
        baseUrl,
        teamId: team.id,
        teamName: team.name,
        channelId: channel.id,
        channelName: channel.name,
        channelDisplayName: channel.displayName,
        syncedAt: 0
      };
      const snapshot = await mmSend({ type: "VRM_MM_SNAPSHOT", source, force: true });
      const existing = VRMeetups.rosterById(state.rosters, draftId);
      const merged = VRMattermost.applySnapshot({ aliases: existing?.aliases || {} }, snapshot.members);

      draftSource = { ...source, syncedAt: snapshot.fetchedAt };
      draftAliases = Object.fromEntries(
        Object.entries(merged.aliases || {}).map(([key, values]) => [key, [...values]])
      );
      rosterText.value = merged.participants.join("\n");
      detailedRows = merged.participants.map((name) =>
        rowFromParticipant(name, { aliases: merged.aliases, statuses: existing?.statuses || {} })
      );
      if (!rosterName.value.trim()) rosterName.value = channel.displayName;
      state = await VRMStorage.patch({
        lastMattermostTeamId: team.id,
        lastMattermostChannelId: channel.id
      });
      applyMode();
      mmSay(`Загружено ${merged.participants.length} чел. из «${channel.displayName}». Не забудьте «Сохранить».`, "success");
    } catch (error) {
      mmSay(error.message, "error");
    } finally {
      mmBusy("");
    }
  }

  function fillSelect(selectedId) {
    rosterSelect.replaceChildren();
    state.rosters.forEach((roster) => {
      const option = document.createElement("option");
      option.value = roster.id;
      option.textContent = roster.name;
      rosterSelect.append(option);
    });
    if (selectedId && VRMeetups.rosterById(state.rosters, selectedId)) rosterSelect.value = selectedId;
    rosterSelect.disabled = state.rosters.length === 0;
    updateRosterCount();
  }

  // Сколько человек в списке — видно в шапке самого списка, дублировать
  // подписью под названием незачем.
  function updateRosterCount() {
    const people = VRMeetups.parseExpected(rosterText.value).length;
    rosterCount.textContent = people ? `${people} чел.` : "";
  }

  function renderAliases() {
    aliasesList.replaceChildren();
    const namesByKey = new Map(
      VRMeetups.parseExpected(rosterText.value).map((name) => [VRMeetups.comparisonKey(name), name])
    );
    const rows = Object.entries(draftAliases).flatMap(([key, aliases]) =>
      (aliases || []).map((alias) => ({ key, name: namesByKey.get(key) || key, alias }))
    );
    // В режиме канала в псевдонимы автоматически попадают логины всех
    // участников — показывать этот список бессмысленно.
    aliasesBlock.hidden = rows.length === 0 || isMattermostMode();

    rows.forEach(({ key, name, alias }) => {
      const row = document.createElement("div");
      row.className = "alias-row";
      const mapping = document.createElement("span");
      mapping.textContent = `${name} ← ${alias}`;
      mapping.title = mapping.textContent;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "alias-remove";
      remove.textContent = "×";
      remove.title = `Удалить псевдоним ${alias}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        draftAliases[key] = (draftAliases[key] || []).filter(
          (item) => VRMeetups.comparisonKey(item) !== VRMeetups.comparisonKey(alias)
        );
        if (!draftAliases[key].length) delete draftAliases[key];
        syncDetailedAliases();
        renderAliases();
        showStatus("Псевдоним удалён. Не забудьте «Сохранить».", "success");
      });
      row.append(mapping, remove);
      aliasesList.append(row);
    });
  }

  // Карточки подробного редактора и карта псевдонимов должны показывать одно
  // и то же.
  function syncDetailedAliases() {
    detailedRows.forEach((row) => {
      row.aliases = [...(draftAliases[VRMeetups.comparisonKey(row.name)] || [])];
    });
    if (detailedActive()) renderDetailedRows();
  }

  function timingForStatus(status) {
    if (!status) return "forever";
    const today = VRMeetups.localDateISO();
    const tomorrow = VRMeetups.addLocalDays(today, 1);
    if (status.from === today && status.until === today) return "today";
    if (status.from === tomorrow && status.until === tomorrow) return "tomorrow";
    if (status.from || status.until) return "range";
    return "forever";
  }

  function rowFromParticipant(name, roster, previousRow) {
    const key = VRMeetups.comparisonKey(name);
    const status = previousRow?.status || roster?.statuses?.[key] || null;
    return {
      id: previousRow?.id || VRMStorage.newId(),
      name,
      status,
      timing: previousRow?.timing || timingForStatus(status),
      aliases: [...(previousRow?.aliases || roster?.aliases?.[key] || [])]
    };
  }

  function setDetailedRowsFromNames(names, roster) {
    const previousByKey = new Map(detailedRows.map((row) => [VRMeetups.comparisonKey(row.name), row]));
    detailedRows = names.map((name) =>
      rowFromParticipant(name, roster, previousByKey.get(VRMeetups.comparisonKey(name)))
    );
  }

  function createField(labelText, control) {
    const field = document.createElement("label");
    field.className = "participant-field";
    const label = document.createElement("span");
    label.textContent = labelText;
    field.append(label, control);
    return field;
  }

  function renderDetailedRows() {
    participantRows.replaceChildren();
    if (!detailedRows.length) {
      const empty = document.createElement("div");
      empty.className = "participant-empty";
      empty.textContent = "Добавьте первого участника";
      participantRows.append(empty);
      return;
    }

    detailedRows.forEach((row) => {
      const card = document.createElement("article");
      card.className = "participant-card";

      const top = document.createElement("div");
      top.className = "participant-card-top";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = row.name;
      nameInput.placeholder = "Имя и фамилия";
      nameInput.setAttribute("aria-label", "Имя участника");
      nameInput.addEventListener("input", () => { row.name = nameInput.value; });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "participant-remove";
      remove.textContent = "×";
      remove.title = "Удалить участника";
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        detailedRows = detailedRows.filter((item) => item.id !== row.id);
        renderDetailedRows();
      });
      top.append(nameInput, remove);

      const typeSelect = document.createElement("select");
      [
        ["", "Без статуса"],
        ["vacation", "🌴 В отпуске"],
        ["absent", "🚌 Отсутствует"]
      ].forEach(([value, label]) => typeSelect.add(new Option(label, value)));
      typeSelect.value = row.status?.type || "";

      const timingSelect = document.createElement("select");
      [
        ["forever", "Без срока"],
        ["today", "Сегодня"],
        ["tomorrow", "Завтра"],
        ["range", "Период"]
      ].forEach(([value, label]) => timingSelect.add(new Option(label, value)));
      timingSelect.value = row.timing;

      const fromInput = document.createElement("input");
      fromInput.type = "date";
      fromInput.value = row.status?.from || VRMeetups.localDateISO();
      const untilInput = document.createElement("input");
      untilInput.type = "date";
      untilInput.value = row.status?.until || fromInput.value;
      const rangeFields = document.createElement("div");
      rangeFields.className = "participant-date-fields";
      rangeFields.append(createField("С", fromInput), createField("До", untilInput));

      function updateStatusFromControls() {
        const type = typeSelect.value;
        row.timing = timingSelect.value;
        timingSelect.disabled = !type;
        rangeFields.hidden = !type || row.timing !== "range";
        if (!type) {
          row.status = null;
        } else if (row.timing === "range") {
          row.status = { type, from: fromInput.value || null, until: untilInput.value || null };
        } else {
          row.status = VRMeetups.statusFromPreset(type, row.timing);
        }
      }
      let previousType = typeSelect.value;
      typeSelect.addEventListener("change", () => {
        if (typeSelect.value !== previousType) {
          row.timing = "forever";
          timingSelect.value = "forever";
          const today = VRMeetups.localDateISO();
          fromInput.value = today;
          untilInput.value = today;
        }
        previousType = typeSelect.value;
        updateStatusFromControls();
      });
      timingSelect.addEventListener("change", updateStatusFromControls);
      fromInput.addEventListener("change", updateStatusFromControls);
      untilInput.addEventListener("change", updateStatusFromControls);
      updateStatusFromControls();

      const statusFields = document.createElement("div");
      statusFields.className = "participant-status-fields";
      statusFields.append(createField("Статус", typeSelect), createField("Срок", timingSelect));

      const aliasesInput = document.createElement("input");
      aliasesInput.type = "text";
      aliasesInput.value = row.aliases.join(", ");
      aliasesInput.placeholder = "Kuznetsoff Nick, другой ник";
      aliasesInput.addEventListener("input", () => {
        row.aliases = aliasesInput.value.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean);
        const key = VRMeetups.comparisonKey(row.name);
        if (row.aliases.length) draftAliases[key] = [...row.aliases];
        else delete draftAliases[key];
        aliasesBlock.hidden = true;
      });

      card.append(top, statusFields, rangeFields, createField("Псевдонимы через запятую", aliasesInput));
      participantRows.append(card);
    });
  }

  function applyEditorMode() {
    // Подробный редактор имеет смысл только для ручного списка: в режиме
    // Mattermost состав всё равно перезапишется каналом.
    if (isMattermostMode()) {
      simpleEditor.hidden = false;
      detailedEditor.hidden = true;
      return;
    }
    detailedToggle.checked = state.detailedEditor === true;
    simpleEditor.hidden = detailedToggle.checked;
    detailedEditor.hidden = !detailedToggle.checked;
    if (detailedToggle.checked) renderDetailedRows();
  }

  function showRoster(roster) {
    draftId = roster?.id || VRMStorage.newId();
    rosterName.value = roster?.name || "";
    rosterText.value = (roster?.participants || []).join("\n");
    detailedRows = (roster?.participants || []).map((name) => rowFromParticipant(name, roster));
    deleteButton.disabled = !roster;
    draftSource = roster?.source ? { ...roster.source } : null;
    stashedSource = null;
    draftAliases = Object.fromEntries(
      Object.entries(roster?.aliases || {}).map(([key, values]) => [key, [...values]])
    );
    prefilledName = "";
    draftMode = roster ? VRMeetups.rosterMode(roster) : "mattermost";
    applyMode();
  }

  function selectRoster(id) {
    const roster = VRMeetups.rosterById(state.rosters, id);
    if (!roster) return;
    state.selectedRosterId = roster.id;
    fillSelect(roster.id);
    showRoster(roster);
    bindRosterToTab(roster.id);
  }

  function startNewRoster() {
    draftId = VRMStorage.newId();
    rosterSelect.selectedIndex = -1;
    // Название встречи — самая вероятная заготовка для названия списка.
    rosterName.value = currentMeetingTitle;
    prefilledName = currentMeetingTitle;
    rosterText.value = "";
    detailedRows = [];
    deleteButton.disabled = true;
    draftSource = null;
    stashedSource = null;
    draftAliases = {};
    // Новый список по умолчанию берётся из Mattermost.
    draftMode = "mattermost";
    applyMode();
    mmPrepare();
    rosterName.focus();
    rosterName.select();
    showStatus(
      currentMeetingTitle
        ? `Название взято из встречи — поправьте, если нужно, и выберите состав.`
        : "Введите название и состав нового списка.",
      "success"
    );
  }

  function collectRosterData(existing) {
    const participants = detailedActive()
      ? VRMeetups.parseExpected(detailedRows.map((row) => row.name).join("\n"))
      : VRMeetups.parseExpected(rosterText.value);
    const rowsByKey = new Map(detailedRows.map((row) => [VRMeetups.comparisonKey(row.name), row]));
    const statuses = {};
    const aliases = {};

    participants.forEach((participant) => {
      const key = VRMeetups.comparisonKey(participant);
      const row = rowsByKey.get(key);
      const candidateStatus = row
        ? (row.status && row.timing !== "range"
          ? VRMeetups.statusFromPreset(row.status.type, row.timing)
          : row.status)
        : existing?.statuses?.[key];
      if (candidateStatus) {
        const validStatus = VRMeetups.normalizeStatus(candidateStatus, null);
        if (!validStatus) throw new Error(`Проверьте период статуса у участника «${participant}».`);
        statuses[key] = validStatus;
      }
      const candidateAliases = row?.aliases?.length
        ? row.aliases
        : (draftAliases[key] || existing?.aliases?.[key] || []);
      if (candidateAliases.length) aliases[key] = candidateAliases;
    });
    return { participants, statuses, aliases };
  }

  async function saveRoster(showConfirmation) {
    const name = rosterName.value.trim();
    if (!name) throw new Error("Введите название списка.");
    if (isMattermostMode() && !draftSource) {
      throw new Error("Выберите канал Mattermost или переключитесь на ручной список.");
    }
    // Страница могла привязать список к встрече, пока окно было открыто:
    // сохраняем поверх свежего состояния, а не поверх прочитанного при старте.
    state = await VRMStorage.load();
    const existingIndex = state.rosters.findIndex((roster) => roster.id === draftId);
    const existing = state.rosters[existingIndex];
    const { participants, statuses, aliases } = collectRosterData(existing);
    if (!participants.length) throw new Error("Добавьте хотя бы одного участника.");

    const savedRoster = {
      id: draftId || VRMStorage.newId(),
      name,
      participants,
      statuses,
      aliases,
      source: draftSource,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    if (existingIndex >= 0) state.rosters[existingIndex] = savedRoster;
    else state.rosters.push(savedRoster);

    state.selectedRosterId = savedRoster.id;
    state.highlightPresent = highlightPresent.checked;
    state.detailedEditor = detailedToggle.checked;
    state = await VRMStorage.save(state);
    const cleanRoster = VRMeetups.rosterById(state.rosters, savedRoster.id);
    draftId = cleanRoster.id;
    fillSelect(cleanRoster.id);
    showRoster(cleanRoster);
    const bound = await bindRosterToTab(cleanRoster.id);
    if (showConfirmation) {
      showStatus(
        bound
          ? `Список «${name}» сохранён и выбран для этой встречи: ${cleanRoster.participants.length} чел.`
          : `Список «${name}» сохранён: ${cleanRoster.participants.length} чел.`,
        "success"
      );
    }
    return cleanRoster;
  }

  async function deleteRoster() {
    const roster = VRMeetups.rosterById(state.rosters, draftId);
    if (!roster || !confirm(`Удалить список «${roster.name}»?`)) return;
    state = await VRMStorage.load();
    state.rosters = state.rosters.filter((item) => item.id !== roster.id);
    [state.roomAssignments, state.titleAssignments].forEach((assignments) => {
      Object.keys(assignments || {}).forEach((key) => {
        if (assignments[key] === roster.id) delete assignments[key];
      });
    });
    if (state.selectedRosterId === roster.id) state.selectedRosterId = state.rosters[0]?.id || null;
    state = await VRMStorage.save(state);
    const next = VRMeetups.rosterForRoom(state, currentRoomKey, currentTitleKey);
    fillSelect(next?.id);
    showRoster(next);
    showStatus(`Список «${roster.name}» удалён.`, "success");
  }

  // Страница встречи сама решает, комната ли это: на обычной вкладке
  // обработчика нет и привязка не создаётся.
  async function bindRosterToTab(rosterId) {
    if (!currentTab?.id || !rosterId) return false;
    try {
      const result = await chrome.tabs.sendMessage(currentTab.id, { type: "VRM_BIND_ROSTER", rosterId });
      if (result?.ok) state = await VRMStorage.load();
      updateRosterCount();
      return Boolean(result?.ok);
    } catch (_error) {
      return false;
    }
  }

  async function init() {
    const meeting = await getMeetingContext();
    currentTab = meeting ? { id: meeting.tabId } : null;
    currentRoomKey = meeting?.roomKey || "";
    currentTitleKey = meeting?.titleKey || "";
    currentMeetingTitle = meeting?.title || "";
    [state, mmLists] = await Promise.all([VRMStorage.load(), VRMStorage.loadLists()]);
    highlightPresent.checked = state.highlightPresent !== false;
    mmStatuses.checked = state.showMattermostStatuses !== false;
    mmUrl.value = state.mattermostUrl || VRMattermost.DEFAULT_BASE_URL;
    const activeRoster = VRMeetups.rosterForRoom(state, currentRoomKey, currentTitleKey);
    fillSelect(activeRoster?.id);
    showRoster(activeRoster);
    if (!activeRoster) startNewRoster();
    mmPrepare();
  }

  // Есть ли несохранённые правки — чтобы не затереть их при переходе на
  // другую вкладку.
  function isDirty() {
    const roster = VRMeetups.rosterById(state.rosters, draftId);
    const typedNames = VRMeetups.parseExpected(rosterText.value).join("\n");
    if (!roster) return Boolean((rosterName.value.trim() && rosterName.value.trim() !== prefilledName) || typedNames);
    return rosterName.value.trim() !== roster.name || typedNames !== roster.participants.join("\n");
  }

  // Панель не закрывается при переключении вкладок, поэтому сама следит за
  // тем, какая встреча сейчас открыта.
  async function refreshTabContext() {
    const meeting = await getMeetingContext();
    if (!meeting) return;
    if (meeting.tabId === currentTab?.id &&
      meeting.roomKey === currentRoomKey &&
      meeting.titleKey === currentTitleKey) return;

    currentTab = { id: meeting.tabId };
    currentRoomKey = meeting.roomKey;
    currentTitleKey = meeting.titleKey;
    currentMeetingTitle = meeting.title;
    state = await VRMStorage.load();

    // Список другой встречи подставляется только когда терять нечего.
    const roster = VRMeetups.rosterForRoom(state, currentRoomKey, currentTitleKey);
    if (roster && roster.id !== draftId && !isDirty()) {
      fillSelect(roster.id);
      showRoster(roster);
    } else {
      updateRosterCount();
    }
  }

  // Состояние подключения решает, показывать ли «Войти»: тому, кто уже вошёл,
  // кнопка не нужна.
  function showSession(session) {
    const connected = Boolean(session?.granted && session?.hasSession);
    mmConnect.hidden = connected;
    mmSession.hidden = !connected;
    if (connected) {
      mmSessionText.textContent = `Подключено как ${session.user?.name || session.user?.username || "—"}`;
    }
    return connected;
  }

  // Всё, что нужно режиму Mattermost: мгновенно показать известное, затем
  // молча обновить в фоне.
  async function mmPrepare() {
    if (!isMattermostMode()) return;
    if (!mmUrl.value) mmUrl.value = state.mattermostUrl || VRMattermost.DEFAULT_BASE_URL;
    showCachedLists();

    const baseUrl = VRMattermost.normalizeBaseUrl(mmUrl.value);
    if (!baseUrl) return;
    let session = null;
    try {
      session = await chrome.runtime.sendMessage({ type: "VRM_MM_SESSION", baseUrl });
    } catch (_error) {
      return;
    }
    if (!showSession(session)) {
      mmSay(session?.granted
        ? "Откройте Mattermost в этом браузере и войдите — потом вернитесь сюда."
        : "Нажмите «Войти», чтобы разрешить расширению читать этот сервер.");
      return;
    }
    try {
      if (!mmListsReady) await mmFillTeams(baseUrl, draftSource?.teamId || state.lastMattermostTeamId);
      if (!draftSource) mmSay("Выберите команду и канал — состав загрузится сам.");
    } catch (error) {
      mmSay(error.message, "error");
    }
  }

  // «Сменить сервер» просто забывает адрес: доступ к домену остаётся, можно
  // сразу ввести другой сервер.
  async function forgetServer() {
    state = await VRMStorage.patch({
      mattermostUrl: "",
      lastMattermostTeamId: "",
      lastMattermostChannelId: ""
    });
    mmLists = await VRMStorage.saveLists({ teams: [], channels: {} });
    stashedSource = null;
    mmListsReady = false;
    mmUrl.value = "";
    mmSession.hidden = true;
    mmConnect.hidden = false;
    showTeams([], "");
    showChannels([], "");
    mmSay("Адрес забыт. Введите другой сервер и нажмите «Войти».");
    mmUrl.focus();
  }

  rosterSelect.addEventListener("change", () => selectRoster(rosterSelect.value));
  newButton.addEventListener("click", startNewRoster);
  addParticipantButton.addEventListener("click", () => {
    const row = rowFromParticipant("", null);
    detailedRows.push(row);
    renderDetailedRows();
    participantRows.lastElementChild?.querySelector('input[type="text"]')?.focus();
  });
  detailedToggle.addEventListener("change", async () => {
    if (detailedToggle.checked) {
      const existing = VRMeetups.rosterById(state.rosters, draftId);
      setDetailedRowsFromNames(VRMeetups.parseExpected(rosterText.value), existing);
    } else {
      rosterText.value = VRMeetups.parseExpected(detailedRows.map((row) => row.name).join("\n")).join("\n");
    }
    applyEditorMode();
    state = await VRMStorage.patch({ detailedEditor: detailedToggle.checked });
  });
  rosterText.addEventListener("input", updateRosterCount);
  deleteButton.addEventListener("click", () => deleteRoster().catch((error) => showStatus(error.message, "error")));
  saveButton.addEventListener("click", () => saveRoster(true).catch((error) => showStatus(error.message, "error")));
  modeMattermost.addEventListener("click", () => setMode("mattermost"));
  modeManual.addEventListener("click", () => {
    setMode("manual");
    mmSay("");
    showStatus("Список ведётся вручную. Не забудьте «Сохранить».", "success");
  });
  mmConnect.addEventListener("click", mmConnectClick);
  mmForget.addEventListener("click", () => forgetServer().catch((error) => mmSay(error.message, "error")));
  mmTeam.addEventListener("change", async () => {
    state = await VRMStorage.patch({ lastMattermostTeamId: mmTeam.value, lastMattermostChannelId: "" });
    // Каналы прошлой команды показывать нельзя, но если для новой они уже
    // в кеше — покажем их сразу, без пустого списка.
    showChannels(mmLists.channels[mmTeam.value] || [], "");
    mmBusy("Загружаю каналы команды…");
    mmFillChannels(VRMattermost.normalizeBaseUrl(mmUrl.value), mmTeam.value, "")
      .catch((error) => mmSay(error.message, "error"))
      .finally(() => mmBusy(""));
  });
  // Состав грузится сам при выборе канала — отдельной кнопки больше нет.
  mmChannel.addEventListener("change", async () => {
    if (!mmChannel.value) return;
    state = await VRMStorage.patch({ lastMattermostChannelId: mmChannel.value });
    mmLoadMembers();
  });
  mmStatuses.addEventListener("change", async () => {
    state = await VRMStorage.patch({ showMattermostStatuses: mmStatuses.checked });
    showStatus(mmStatuses.checked ? "Статусы из Mattermost включены." : "Статусы из Mattermost выключены.", "success");
  });
  highlightPresent.addEventListener("change", async () => {
    state = await VRMStorage.patch({ highlightPresent: highlightPresent.checked });
    showStatus(highlightPresent.checked ? "Подсветка пришедших включена." : "Подсветка пришедших выключена.", "success");
  });

  // Панель живёт долго, поэтому реагирует на просьбу со страницы открыть
  // редактор и на правки списков, сделанные там же.
  async function applyEditorIntent() {
    const stored = await chrome.storage.local.get("editorIntent");
    const intent = VRMeetups.editorIntent(stored.editorIntent);
    if (!intent) return;
    await chrome.storage.local.remove("editorIntent");

    state = await VRMStorage.load();
    if (intent.blank) {
      fillSelect(null);
      startNewRoster();
    } else {
      const roster = VRMeetups.rosterById(state.rosters, intent.rosterId);
      if (!roster) return;
      fillSelect(roster.id);
      showRoster(roster);
      showStatus(`Редактируем список «${roster.name}».`, "success");
    }
    rosterName.focus();
    rosterName.select();
  }

  // Фон спрашивает, открыт ли редактор: если да, второе окно не нужно —
  // намерение и так прилетит через хранилище.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "VRM_PANEL_PING") return undefined;
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.editorIntent?.newValue) {
      applyEditorIntent().catch((error) => showStatus(error.message, "error"));
      return;
    }
    // Списки и привязки могли измениться на странице — подтягиваем, чтобы
    // следующее сохранение не затёрло чужую правку и выпадающий список не врал.
    const touched = ["rosters", "roomAssignments", "titleAssignments", "selectedRosterId"];
    if (!touched.some((key) => changes[key])) return;
    VRMStorage.load().then((fresh) => {
      state = fresh;
      if (isDirty()) return;
      const roster = VRMeetups.rosterById(state.rosters, draftId) ||
        VRMeetups.rosterForRoom(state, currentRoomKey, currentTitleKey);
      fillSelect(roster?.id);
      if (roster && roster.id !== draftId) showRoster(roster);
    }).catch(() => {});
  });

  chrome.tabs.onActivated.addListener(() => {
    refreshTabContext().catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTab?.id && (changeInfo.url || changeInfo.title)) {
      refreshTabContext().catch(() => {});
    }
  });

  init()
    .then(applyEditorIntent)
    .catch((error) => showStatus(error.message, "error"));
})();
