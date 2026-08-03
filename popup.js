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
  const bindRoom = document.getElementById("bind-room");
  const roomLabel = document.getElementById("room-label");
  const highlightPresent = document.getElementById("highlight-present");
  const newButton = document.getElementById("new-roster");
  const deleteButton = document.getElementById("delete-roster");
  const saveButton = document.getElementById("save");
  const checkButton = document.getElementById("check");
  const statusBox = document.getElementById("status");

  let state = {
    rosters: [],
    roomAssignments: {},
    selectedRosterId: null,
    highlightPresent: true,
    detailedEditor: false
  };
  let currentRoomKey = "";
  let currentTab = null;
  let draftId = null;
  let detailedRows = [];

  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.className = `status visible ${kind}`;
  }

  function setBusy(busy) {
    newButton.disabled = busy;
    saveButton.disabled = busy;
    checkButton.disabled = busy;
    addParticipantButton.disabled = busy;
    deleteButton.disabled = busy || !VRMeetups.rosterById(state.rosters, draftId);
    checkButton.textContent = busy ? "Проверяю…" : "Проверить сейчас";
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function fillSelect(selectedId) {
    rosterSelect.replaceChildren();
    state.rosters.forEach((roster) => {
      const option = document.createElement("option");
      option.value = roster.id;
      option.textContent = `${roster.name} (${roster.participants.length})`;
      rosterSelect.append(option);
    });
    if (selectedId && VRMeetups.rosterById(state.rosters, selectedId)) rosterSelect.value = selectedId;
    rosterSelect.disabled = state.rosters.length === 0;
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
      aliasesInput.placeholder = "Lipanti Nick, другой ник";
      aliasesInput.addEventListener("input", () => {
        row.aliases = aliasesInput.value.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean);
      });

      card.append(top, statusFields, rangeFields, createField("Псевдонимы через запятую", aliasesInput));
      participantRows.append(card);
    });
  }

  function applyEditorMode() {
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
    applyEditorMode();
  }

  function selectRoster(id) {
    const roster = VRMeetups.rosterById(state.rosters, id);
    if (!roster) return;
    state.selectedRosterId = roster.id;
    fillSelect(roster.id);
    showRoster(roster);
    bindRoom.checked = state.roomAssignments[currentRoomKey] === roster.id;
  }

  function startNewRoster() {
    draftId = VRMStorage.newId();
    rosterSelect.selectedIndex = -1;
    rosterName.value = "";
    rosterText.value = "";
    detailedRows = [];
    bindRoom.checked = false;
    deleteButton.disabled = true;
    applyEditorMode();
    rosterName.focus();
    showStatus("Введите название и состав нового списка.", "success");
  }

  function collectRosterData(existing) {
    const participants = state.detailedEditor
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
      const candidateAliases = row ? row.aliases : (existing?.aliases?.[key] || []);
      if (candidateAliases.length) aliases[key] = candidateAliases;
    });
    return { participants, statuses, aliases };
  }

  async function saveRoster(showConfirmation) {
    const name = rosterName.value.trim();
    if (!name) throw new Error("Введите название списка.");
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
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    if (existingIndex >= 0) state.rosters[existingIndex] = savedRoster;
    else state.rosters.push(savedRoster);

    state.selectedRosterId = savedRoster.id;
    state.highlightPresent = highlightPresent.checked;
    state.detailedEditor = detailedToggle.checked;
    if (currentRoomKey) {
      if (bindRoom.checked) state.roomAssignments[currentRoomKey] = savedRoster.id;
      else delete state.roomAssignments[currentRoomKey];
    }

    state = await VRMStorage.save(state);
    const cleanRoster = VRMeetups.rosterById(state.rosters, savedRoster.id);
    draftId = cleanRoster.id;
    fillSelect(cleanRoster.id);
    showRoster(cleanRoster);
    if (showConfirmation) showStatus(`Список «${name}» сохранён: ${cleanRoster.participants.length} чел.`, "success");
    return cleanRoster;
  }

  async function deleteRoster() {
    const roster = VRMeetups.rosterById(state.rosters, draftId);
    if (!roster || !confirm(`Удалить список «${roster.name}»?`)) return;
    state.rosters = state.rosters.filter((item) => item.id !== roster.id);
    Object.keys(state.roomAssignments).forEach((key) => {
      if (state.roomAssignments[key] === roster.id) delete state.roomAssignments[key];
    });
    if (state.selectedRosterId === roster.id) state.selectedRosterId = state.rosters[0]?.id || null;
    state = await VRMStorage.save(state);
    const next = VRMeetups.rosterForRoom(state, currentRoomKey);
    fillSelect(next?.id);
    showRoster(next);
    bindRoom.checked = Boolean(next && state.roomAssignments[currentRoomKey] === next.id);
    showStatus(`Список «${roster.name}» удалён.`, "success");
  }

  async function checkParticipants() {
    setBusy(true);
    try {
      const savedRoster = await saveRoster(false);
      if (!currentTab?.id) throw new Error("Не удалось определить открытую вкладку.");
      const result = await chrome.tabs.sendMessage(currentTab.id, {
        type: "VRM_SCAN_PARTICIPANTS",
        rosterId: savedRoster.id
      });
      if (!result?.ok) {
        showStatus(result?.message || "Откройте панель «Участники» и повторите проверку.", "warning");
      } else if (result.missing.length === 0) {
        showStatus(`«${result.rosterName}»: все ${result.expected} на месте.`, "success");
      } else {
        showStatus(
          `«${result.rosterName}»: пришли ${result.presentExpected} из ${result.expected}. Не пришли: ${result.missing.join(", ")}.`,
          "warning"
        );
      }
    } catch (error) {
      const inaccessible = /Receiving end does not exist|Could not establish connection/i.test(error.message);
      showStatus(inaccessible ? "Обновите вкладку VirtualRoom после обновления расширения." : error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    currentTab = await getActiveTab();
    currentRoomKey = VRMeetups.roomKey(currentTab?.url || "");
    roomLabel.textContent = currentTab?.title || currentRoomKey || "Текущая вкладка";
    roomLabel.title = currentRoomKey;
    state = await VRMStorage.load();
    highlightPresent.checked = state.highlightPresent !== false;
    const activeRoster = VRMeetups.rosterForRoom(state, currentRoomKey);
    fillSelect(activeRoster?.id);
    showRoster(activeRoster);
    bindRoom.checked = Boolean(activeRoster && state.roomAssignments[currentRoomKey] === activeRoster.id);
    if (!activeRoster) startNewRoster();
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
    state.detailedEditor = detailedToggle.checked;
    applyEditorMode();
    state = await VRMStorage.save(state);
  });
  deleteButton.addEventListener("click", () => deleteRoster().catch((error) => showStatus(error.message, "error")));
  saveButton.addEventListener("click", () => saveRoster(true).catch((error) => showStatus(error.message, "error")));
  checkButton.addEventListener("click", checkParticipants);
  highlightPresent.addEventListener("change", async () => {
    state.highlightPresent = highlightPresent.checked;
    state = await VRMStorage.save(state);
    showStatus(highlightPresent.checked ? "Подсветка пришедших включена." : "Подсветка пришедших выключена.", "success");
  });

  init().catch((error) => showStatus(error.message, "error"));
})();
