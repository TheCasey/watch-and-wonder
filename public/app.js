import { worksheetFlow, orderBySource } from "./worksheet-order.js";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  token: "",
  lessons: [],
  active: null,
  source: "url",
  account: null,
  card: 0,
  revealed: false,
  currentPane: "worksheet",
  editing: null,
  importing: false,
  polling: false,
  health: null,
};
const busy = (lesson) =>
  ["importing", "generating", "queued"].includes(lesson?.status);
const labels = {
  blanks: "Fill in the blanks",
  watch: "While you watch",
  reflection: "After you watch",
  activity: "Try it yourself",
  vocabulary: "Words to know",
  sequence: "Put it in order",
  sketch: "Sketch & explain",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = !message;
}
async function api(url, { method = "GET", body, raw = false } = {}) {
  const response = await fetch(`/api${url}`, {
    method,
    headers: {
      "x-wonder-token": state.token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let value;
    try {
      value = await response.json();
    } catch {}
    throw new Error(
      value?.error ||
        "The local service did not respond. Check that the app is running.",
    );
  }
  return raw ? response : response.json();
}
async function action(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function settings(prefix = "") {
  const read = (id) => $(`#${prefix}${id}`);
  const sections = [
    ...read("section-choices").querySelectorAll("input:checked"),
  ].map((i) => i.value);
  return {
    sections,
    density: read("density").querySelector(".selected").dataset.value,
    level: read("reading-level").value,
    paper: read("paper").value,
    lines: read("lines").value,
    wordBank: read("word-bank").checked,
    flashcards: read("flashcards").checked,
    quiz: read("quiz").checked,
    notes: read("parent-notes").value,
    model: $("#model-picker").value,
  };
}
function setSettings(value, prefix = "") {
  const read = (id) => $(`#${prefix}${id}`);
  for (const [id, key] of [
    ["reading-level", "level"],
    ["paper", "paper"],
    ["lines", "lines"],
    ["parent-notes", "notes"],
  ])
    read(id).value = value[key] || "";
  for (const [id, key] of [
    ["word-bank", "wordBank"],
    ["flashcards", "flashcards"],
    ["quiz", "quiz"],
  ])
    read(id).checked = Boolean(value[key]);
  read("section-choices")
    .querySelectorAll("input")
    .forEach((i) => {
      i.checked = value.sections.includes(i.value);
    });
  read("density")
    .querySelectorAll("button")
    .forEach((b) => {
      b.classList.toggle("selected", b.dataset.value === value.density);
      b.setAttribute("aria-pressed", b.dataset.value === value.density);
    });
}
function hasSelection(value) {
  if (!value.sections.length && !value.flashcards && !value.quiz)
    throw new Error(
      "Choose at least one worksheet section or separate study tool.",
    );
}
function showCreate() {
  state.active = null;
  $("#create-view").hidden = false;
  $("#lesson-view").hidden = true;
  notice("");
  renderLibrary();
  window.scrollTo(0, 0);
}
function renderLibrary() {
  const list = $("#library");
  list.replaceChildren();
  if (!state.lessons.length)
    list.append(el("p", "Your next discovery belongs here.", "library-empty"));
  for (const lesson of state.lessons) {
    const button = el(
      "button",
      "",
      `library-item${lesson.id === state.active?.id ? " active" : ""}`,
    );
    button.append(
      el("span", lesson.title),
      el(
        "small",
        `${lesson.status === "done" ? "Ready to print" : lesson.status === "ready" ? "Transcript ready" : lesson.status === "failed" ? "Needs attention" : lesson.stage} · ${new Date(lesson.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      ),
    );
    button.addEventListener("click", () =>
      action(button, () => openLesson(lesson.id)),
    );
    list.append(button);
  }
}
async function refreshLibrary() {
  state.lessons = await api("/lessons");
  renderLibrary();
}
function switchPane(view) {
  state.currentPane = view;
  for (const name of ["worksheet", "transcript", "cards", "quiz"])
    $(`#${name}-pane`).hidden = name !== view;
  $$(".lesson-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
    button.setAttribute("aria-selected", button.dataset.view === view);
  });
}
async function openLesson(id, pane) {
  state.active = await api(`/lessons/${id}`);
  state.card = 0;
  state.revealed = false;
  $("#create-view").hidden = true;
  $("#lesson-view").hidden = false;
  notice("");
  renderLesson();
  renderLibrary();
  switchPane(pane || (state.active.worksheet ? "worksheet" : "transcript"));
  window.scrollTo(0, 0);
}
function reference(item) {
  const detail = el("details", undefined, "source-reference");
  detail.append(el("summary", "Check source evidence"));
  for (const evidence of item.evidence) {
    const index = Number(evidence.sourceId.slice(1)) - 1,
      segment = (state.active.worksheetTranscript || state.active.transcript)
        ?.segments[index];
    detail.append(
      el(
        "p",
        Number.isFinite(segment?.startMs)
          ? `Video ${time(segment.startMs)}`
          : `Source paragraph ${index + 1}`,
      ),
      el("blockquote", evidence.quote),
    );
  }
  return detail;
}
function empty(title, description, create = false) {
  const node = el("div", undefined, "empty-state");
  node.append(el("h3", title), el("p", description));
  if (create) {
    const button = el(
      "button",
      "Customize & create worksheet →",
      "button primary",
    );
    button.addEventListener("click", openCustomize);
    node.append(button);
  }
  return node;
}
function renderWorksheet() {
  const area = $("#worksheet-preview"),
    worksheet = state.active.worksheet;
  area.replaceChildren();
  for (const id of [
    "guided-download",
    "key-download",
    "edit-worksheet",
    "export-json",
  ])
    $(`#${id}`).disabled = !worksheet;
  if (!worksheet) {
    area.append(
      empty(
        "A good lesson starts here.",
        "Review your transcript, choose your sections, and create a worksheet.",
        Boolean(state.active.transcript) && !busy(state.active),
      ),
    );
    return;
  }
  const paper = el("article", undefined, "worksheet-sheet");
  paper.append(
    el("div", "WATCH & WONDER", "paper-brand"),
    el("h2", worksheet.title),
    el(
      "p",
      "Name: ______________________________    Date: ______________",
      "hint",
    ),
    el("p", worksheet.introduction),
  );
  if (!worksheet.sections.length)
    paper.append(
      el(
        "p",
        "This lesson has separate study tools. Open Flashcards or Practice quiz above.",
      ),
    );
  let questionIndex = 0;
  for (const group of worksheetFlow(
    worksheet,
    state.active.worksheetTranscript || state.active.transcript,
  )) {
    paper.append(
      el(
        "h3",
        group.kind === "during" ? "While you watch" : labels[group.kind],
      ),
    );
    const blanks = group.items.filter((entry) => entry.kind === "blanks");
    if (
      blanks.length &&
      (state.active.worksheetSettings || state.active.settings).wordBank
    )
      paper.append(
        el(
          "p",
          `Word bank: ${[...new Set(blanks.map((entry) => entry.item.answer))].sort().join(" · ")}`,
          "hint",
        ),
      );
    if (group.kind === "activity")
      paper.append(
        el(
          "p",
          "Suggested extension. Read the whole activity with an adult before starting.",
          "hint",
        ),
      );
    for (const { kind, item } of group.items) {
      const node = el("div", undefined, `worksheet-item ${kind}`);
      const prompt =
        kind === "blanks"
          ? item.prompt.replace(
              /_{3,}/g,
              "_".repeat(
                Math.max(28, Math.min(56, [...item.answer].length * 2)),
              ),
            )
          : item.prompt;
      node.append(
        el("div", `${++questionIndex}. ${prompt}`),
        el("div", "", "answer-lines"),
        reference(item),
      );
      paper.append(node);
    }
  }
  area.append(paper);
  const text = el(
    "p",
    "The PDF adds page breaks, writing space, and page numbers. Student PDFs contain no source quotes or answer key.",
    "hint",
  );
  area.append(text);
}
function time(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function renderTranscript() {
  const area = $("#transcript-content");
  area.replaceChildren();
  $("#transcript-editor").hidden = true;
  area.hidden = false;
  const segments = state.active.transcript?.segments || [];
  $("#transcript-download").disabled = !segments.length;
  $("#edit-transcript").disabled = !segments.length || busy(state.active);
  if (!segments.length) {
    area.append(
      el(
        "p",
        "The transcript will appear here after local Whisper finishes.",
        "hint",
      ),
    );
    return;
  }
  segments.forEach((segment, i) => {
    const node = el("div", undefined, "transcript-segment");
    node.append(
      el(
        "small",
        Number.isFinite(segment.startMs)
          ? `${time(segment.startMs)} – ${time(segment.endMs)}`
          : `PARAGRAPH ${i + 1}`,
      ),
      el("p", segment.text),
    );
    area.append(node);
  });
}
function renderCards() {
  const cards = state.active.worksheet?.flashcards || [],
    area = $("#cards-content");
  area.replaceChildren();
  $("#cards-download").disabled = !cards.length;
  $("#cards-tsv").disabled = !cards.length;
  if (!cards.length) {
    area.append(
      empty(
        "Keep a few good ideas close.",
        "Select Flashcards when customizing this lesson to create a separate deck.",
        Boolean(state.active.transcript) && !busy(state.active),
      ),
    );
    return;
  }
  state.card %= cards.length;
  const card = cards[state.card],
    box = el("div", undefined, "flashcard");
  box.append(
    el("p", `${state.card + 1} / ${cards.length}`, "hint"),
    el("div", card.front, "front"),
  );
  const reveal = el(
    "button",
    state.revealed ? "Hide answer" : "Reveal answer",
    "button primary",
  );
  reveal.addEventListener("click", () => {
    state.revealed = !state.revealed;
    renderCards();
  });
  box.append(reveal);
  if (state.revealed) box.append(el("div", card.back, "back"), reference(card));
  const controls = el("div", undefined, "card-controls");
  for (const [label, offset] of [
    ["← Previous", -1],
    ["Next →", 1],
  ]) {
    const button = el("button", label, "button");
    button.addEventListener("click", () => {
      state.card = (state.card + offset + cards.length) % cards.length;
      state.revealed = false;
      renderCards();
    });
    controls.append(button);
  }
  area.append(box, controls);
}
function renderQuiz() {
  const quiz = orderBySource(
      state.active.worksheet?.quiz || [],
      state.active.worksheetTranscript || state.active.transcript,
    ),
    area = $("#quiz-content");
  area.replaceChildren();
  $("#quiz-download").disabled = !quiz.length;
  $("#quiz-key-download").disabled = !quiz.length;
  if (!quiz.length) {
    area.append(
      empty(
        "Find out what stuck.",
        "Select Practice quiz when customizing this lesson for a separate quiz.",
        Boolean(state.active.transcript) && !busy(state.active),
      ),
    );
    return;
  }
  quiz.forEach((item, index) => {
    const node = el("div", undefined, "quiz-question");
    node.append(el("p", `${index + 1}. ${item.prompt}`));
    const choices = el("div", undefined, "quiz-choices");
    let text;
    if (item.choices.length)
      item.choices.forEach((choice, j) => {
        const label = el("label", undefined, "quiz-choice"),
          radio = el("input");
        radio.type = "radio";
        radio.name = `quiz-${index}`;
        radio.value = choice;
        label.append(
          radio,
          el("span", `${String.fromCharCode(65 + j)}. ${choice}`),
        );
        choices.append(label);
      });
    else {
      text = el("textarea");
      text.rows = 3;
      text.setAttribute("aria-label", `Your answer to question ${index + 1}`);
      choices.append(text);
    }
    const check = el(
        "button",
        item.choices.length ? "Check answer" : "Show example answer",
        "button",
      ),
      feedback = el("div", undefined, "quiz-feedback");
    feedback.hidden = true;
    check.addEventListener("click", () => {
      if (item.choices.length) {
        const selected = choices.querySelector("input:checked");
        if (!selected) {
          notice("Choose an answer first.");
          return;
        }
        feedback.textContent = `${selected.value === item.answer ? "That’s right!" : "Keep exploring."}\nAnswer: ${item.answer}`;
      } else feedback.textContent = `Example answer: ${item.answer}`;
      feedback.hidden = false;
      check.hidden = true;
      feedback.append(reference(item));
    });
    node.append(choices, check, feedback);
    area.append(node);
  });
}
function renderLesson() {
  const lesson = state.active;
  $("#saved-title").textContent = lesson.title;
  $("#saved-source").textContent =
    lesson.url ||
    "Imported transcript / script · Grounded in the text you provided";
  const status = $("#job-status");
  status.replaceChildren();
  status.classList.toggle("error", lesson.status === "failed");
  if (busy(lesson)) status.append(el("span", "", "spinner"));
  status.append(el("span", lesson.error || lesson.stage));
  if (lesson.transcript && !lesson.worksheet && !busy(lesson)) {
    const button = el("button", "Choose options & create →", "button primary");
    button.addEventListener("click", openCustomize);
    status.append(document.createTextNode("  "), button);
  }
  $("#retry").hidden = lesson.status !== "failed";
  for (const id of ["rename", "customize", "delete-lesson"])
    $(`#${id}`).disabled =
      busy(lesson) || (id === "customize" && !lesson.transcript);
  $("#version-count").textContent = lesson.versions.length
    ? `${lesson.versions.length} saved version${lesson.versions.length === 1 ? "" : "s"}`
    : "";
  $("#versions").hidden = !lesson.versions.length;
  const history = $("#version-picker");
  history.replaceChildren();
  for (const [i, version] of lesson.versions.entries()) {
    const option = el(
      "option",
      `Version ${i + 1} · ${new Date(version.createdAt).toLocaleString()}${version.edited ? " · edited" : version.restored ? " · restored" : ""}`,
    );
    option.value = version.id;
    option.selected = version.id === lesson.version;
    history.append(option);
  }
  $("#restore-version").disabled = busy(lesson);
  renderWorksheet();
  renderTranscript();
  renderCards();
  renderQuiz();
}
function openCustomize() {
  if (!state.active?.transcript || busy(state.active)) return;
  const target = $("#customize-options");
  target.replaceChildren();
  const clone = $("#reading-level").closest(".panel").cloneNode(true);
  clone.querySelector(".step-title").remove();
  clone.querySelectorAll("[id]").forEach((node) => {
    const old = node.id;
    node.id = `custom-${old}`;
    clone.querySelectorAll(`[for="${old}"]`).forEach((label) => {
      label.htmlFor = node.id;
    });
  });
  target.append(clone);
  setSettings(state.active.settings, "custom-");
  $("#customize-dialog").showModal();
}
function exportName(kind) {
  const title =
    state.active.title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .slice(0, 80) || "lesson";
  return `${title}-${kind}.${kind === "transcript" ? "txt" : kind === "json" ? "json" : kind === "cards-tsv" ? "tsv" : "pdf"}`;
}
async function download(kind) {
  const response = await api(`/lessons/${state.active.id}/export/${kind}`, {
      raw: true,
    }),
    blob = await response.blob();
  const url = URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = exportName(kind);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function loadAccount() {
  state.account = await api("/account");
  const account = state.account;
  $("#connection").replaceChildren(
    el("span", "", "local-dot"),
    document.createTextNode(
      account.eligible ? "ChatGPT connected" : "Local workspace · Setup",
    ),
  );
  $("#account-status").replaceChildren(
    el(
      "p",
      account.signInPending
        ? "Complete sign-in in the browser, then return here."
        : account.eligible
          ? `Connected${account.account?.email ? ` as ${account.account.email}` : ""} · Ready to generate`
          : account.connected
            ? "Connected; plan usage is not available yet."
            : "Connect your account to create learning materials.",
    ),
  );
  for (const issue of account.issues || [])
    $("#account-status").append(el("p", issue, "hint"));
  $("#sign-out").hidden = !account.connected;
  const accounts = $("#account-picker");
  accounts.replaceChildren();
  if (!account.accounts.length) {
    const option = el("option", "No saved accounts");
    option.value = "";
    accounts.append(option);
  }
  for (const record of account.accounts) {
    const option = el("option", record.label);
    option.value = record.id;
    option.selected = record.active;
    accounts.append(option);
  }
  const picker = $("#model-picker"),
    previous = picker.value || localStorage.getItem("wonder-model") || "";
  picker.replaceChildren();
  const defaultOption = el("option", "Account default");
  defaultOption.value = "";
  picker.append(defaultOption);
  for (const model of account.models || []) {
    const option = el("option", model.displayName);
    option.value = model.slug;
    picker.append(option);
  }
  if ([...picker.options].some((o) => o.value === previous))
    picker.value = previous;
}
async function showSettings() {
  $("#settings-dialog").showModal();
  $("#setup-health").textContent = "Checking local tools…";
  const [health] = await Promise.all([api("/health"), loadAccount()]);
  state.health = health;
  const area = $("#setup-health");
  area.replaceChildren();
  for (const [label, info] of [
    ["Whisper transcription", health.whisper],
    ["Video importer · yt-dlp", health.downloader],
  ]) {
    const item = el("div", `${info.ready ? "✓" : "○"} ${label}`, "setup-item");
    item.append(
      el("small", info.ready ? info.model || "Ready" : info.issues.join(" ")),
    );
    area.append(item);
  }
  $("#library-location").textContent = health.dataDir;
}
$("#restore-version").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    state.active = await api(`/lessons/${state.active.id}/restore`, {
      method: "POST",
      body: { version: $("#version-picker").value },
    });
    renderLesson();
    await refreshLibrary();
    notice(
      "Saved worksheet restored. Its original transcript references and print settings are preserved.",
    );
  }),
);
$("#new-lesson").addEventListener("click", showCreate);
for (const type of ["url", "script"])
  $(`#${type}-tab`).addEventListener("click", () => {
    state.source = type;
    for (const name of ["url", "script"]) {
      $(`#${name}-tab`).classList.toggle("active", name === type);
      $(`#${name}-tab`).setAttribute("aria-selected", name === type);
      $(`#${name}-input`).hidden = name !== type;
    }
  });
document.addEventListener("click", (event) => {
  const button = event.target.closest(".density button");
  if (button) {
    button.parentElement.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("selected", b === button);
      b.setAttribute("aria-pressed", b === button);
    });
  }
  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close).close();
});
$("#script").addEventListener("input", () => {
  $("#script-count").textContent =
    `${$("#script").value.length.toLocaleString()} characters`;
});
$("#script-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 3_600_000) {
    notice("This file is too large. Split it into separate lessons.", true);
    return;
  }
  $("#script").value = await file.text();
  $("#script").dispatchEvent(new Event("input"));
  if (!$("#lesson-title").value)
    $("#lesson-title").value = file.name.replace(/\.[^.]+$/, "");
});
$("#import").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    const value = settings();
    hasSelection(value);
    const text = $("#script").value,
      url = $("#video-url").value.trim();
    if (state.source === "script" && !text.trim())
      throw new Error("Paste a transcript or open a text file first.");
    if (state.source === "url" && !url)
      throw new Error("Paste an individual YouTube or PBS video link first.");
    const lesson = await api("/lessons", {
      method: "POST",
      body: {
        type: state.source,
        title: $("#lesson-title").value,
        text,
        url,
        settings: value,
      },
    });
    await refreshLibrary();
    await openLesson(lesson.id, "transcript");
  }),
);
$$(".lesson-tabs button").forEach((button) =>
  button.addEventListener("click", () => switchPane(button.dataset.view)),
);
for (const id of ["settings-open", "connection"])
  $(`#${id}`).addEventListener("click", (event) =>
    action(event.currentTarget, showSettings),
  );
for (const id of ["sign-in", "add-account"])
  $(`#${id}`).addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      let popup;
      try {
        const result = await api("/account/sign-in", {
          method: "POST",
          body: { newAccount: id === "add-account" },
        });
        popup = window.open(result.url, "_blank");
        if (!popup) {
          const link = el("a", "Open ChatGPT sign-in ↗", "button");
          link.href = result.url;
          link.target = "_blank";
          link.rel = "noreferrer";
          $("#account-status").append(link);
        }
        await loadAccount();
      } catch (error) {
        popup?.close();
        throw error;
      }
    }),
  );
$("#sign-out").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await api("/account/sign-out", { method: "POST" });
    await loadAccount();
  }),
);
$("#account-picker").addEventListener("change", (event) =>
  action(event.currentTarget, async () => {
    if (event.target.value) {
      await api("/account/select", {
        method: "POST",
        body: { id: event.target.value },
      });
      await loadAccount();
    }
  }),
);
$("#model-picker").addEventListener("change", (event) =>
  localStorage.setItem("wonder-model", event.target.value),
);
$("#customize").addEventListener("click", openCustomize);
$("#generate").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    const value = settings("custom-");
    hasSelection(value);
    state.active = await api(`/lessons/${state.active.id}/generate`, {
      method: "POST",
      body: value,
    });
    $("#customize-dialog").close();
    renderLesson();
    switchPane("worksheet");
    await refreshLibrary();
  }),
);
$("#retry").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    state.active = await api(`/lessons/${state.active.id}/retry`, {
      method: "POST",
    });
    renderLesson();
    await refreshLibrary();
  }),
);
for (const [id, kind] of [
  ["guided-download", "guided"],
  ["key-download", "key"],
  ["cards-download", "cards"],
  ["cards-tsv", "cards-tsv"],
  ["quiz-download", "quiz"],
  ["quiz-key-download", "quiz-key"],
  ["transcript-download", "transcript"],
  ["export-json", "json"],
])
  $(`#${id}`).addEventListener("click", (event) =>
    action(event.currentTarget, () => download(kind)),
  );
$("#edit-transcript").addEventListener("click", () => {
  const transcript = state.active.transcript;
  const srtTime = (ms) => {
    const whole = Math.round(ms),
      h = Math.floor(whole / 3600000),
      m = Math.floor(whole / 60000) % 60,
      s = Math.floor(whole / 1000) % 60;
    return `${[h, m, s].map((v) => String(v).padStart(2, "0")).join(":")},${String(whole % 1000).padStart(3, "0")}`;
  };
  $("#transcript-text").value = transcript.segments.every((s) =>
    Number.isFinite(s.startMs),
  )
    ? transcript.segments
        .map(
          (s, i) =>
            `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(s.endMs)}\n${s.text}`,
        )
        .join("\n\n")
    : transcript.segments.map((s) => s.text).join("\n\n");
  $("#transcript-content").hidden = true;
  $("#transcript-editor").hidden = false;
});
$("#cancel-transcript").addEventListener("click", renderTranscript);
$("#save-transcript").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    state.active = await api(`/lessons/${state.active.id}/transcript`, {
      method: "PUT",
      body: { text: $("#transcript-text").value },
    });
    renderLesson();
    notice("Transcript saved. Generate again to update the worksheet.");
    await refreshLibrary();
  }),
);
$("#rename").addEventListener("click", () => {
  $("#rename-title").value = state.active.title;
  $("#rename-dialog").showModal();
});
$("#save-title").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    state.active = await api(`/lessons/${state.active.id}/title`, {
      method: "PUT",
      body: { title: $("#rename-title").value },
    });
    $("#rename-dialog").close();
    renderLesson();
    await refreshLibrary();
  }),
);
$("#delete-lesson").addEventListener("click", () =>
  $("#confirm-dialog").showModal(),
);
$("#confirm-cancel").addEventListener("click", () =>
  $("#confirm-dialog").close(),
);
$("#confirm-delete").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await api(`/lessons/${state.active.id}`, { method: "DELETE" });
    $("#confirm-dialog").close();
    showCreate();
    await refreshLibrary();
  }),
);
$("#edit-worksheet").addEventListener("click", () => {
  if (!state.active.worksheet) return;
  state.editing = structuredClone(state.active.worksheet);
  const area = $("#edit-content");
  area.replaceChildren();
  const entries = [
    ...state.editing.sections.flatMap((s) =>
      s.items.map((item) => ({
        item,
        label: labels[s.kind],
        fields: ["prompt", "answer"],
      })),
    ),
    ...state.editing.flashcards.map((item) => ({
      item,
      label: "Flashcard",
      fields: ["front", "back"],
    })),
    ...state.editing.quiz.map((item) => ({
      item,
      label: "Practice quiz",
      fields: ["prompt", "answer"],
    })),
  ];
  for (const { item, label, fields } of entries) {
    const node = el("div", undefined, "edit-item");
    node.append(el("h3", label));
    for (const field of fields) {
      const input = el("textarea");
      input.value = item[field];
      input.setAttribute("aria-label", `${label} ${field}`);
      input.addEventListener("input", () => {
        const previous = item[field];
        item[field] = input.value;
        if (field === "answer" && item.choices?.includes(previous))
          item.choices[item.choices.indexOf(previous)] = input.value;
      });
      node.append(el("label", field.toUpperCase()), input);
    }
    node.append(reference(item));
    area.append(node);
  }
  $("#edit-dialog").showModal();
});
$("#save-worksheet").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    state.active = await api(`/lessons/${state.active.id}/worksheet`, {
      method: "PUT",
      body: state.editing,
    });
    $("#edit-dialog").close();
    renderLesson();
    notice(
      "Edits saved as a new version. The printable PDFs use your changes.",
    );
    await refreshLibrary();
  }),
);
async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    if (state.active && busy(state.active)) {
      const next = await api(`/lessons/${state.active.id}`);
      if (
        next.status !== state.active.status ||
        next.stage !== state.active.stage ||
        next.error !== state.active.error
      ) {
        const oldStatus = state.active.status;
        state.active = next;
        renderLesson();
        if (oldStatus !== next.status) await refreshLibrary();
      }
    } else if (state.lessons.some(busy)) await refreshLibrary();
    if (state.account?.signInPending) await loadAccount();
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.polling = false;
  }
}
async function start() {
  const bootstrap = await fetch("/api/bootstrap");
  state.token = (await bootstrap.json()).token;
  await Promise.all([refreshLibrary(), loadAccount()]);
  setInterval(poll, 2500);
}
start().catch((error) => notice(error.message, true));
