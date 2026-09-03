const DEFAULT_HABITS = [
  ["Wake up at 06:00", "⏰"], ["Meditation", "🧘"], ["GYM", "💪"],
  ["Cold Shower", "🚿"], ["Work", "💼"], ["Read 10 pages", "📖"],
  ["Learn a skill", "📝"], ["No sugar", "🍬"], ["No alcohol", "🍷"],
  ["Social media limit", "📵"], ["Planning", "🗓️"], ["Sleep before 11:00", "🌙"]
];
const HABIT_SUGGESTIONS = [
  ["Drink water", "💧"], ["Morning walk", "🚶"], ["Journal", "✍️"],
  ["Stretch", "🤸"], ["Practice coding", "💻"], ["Read a book", "📚"],
  ["Language practice", "🗣️"], ["No phone before bed", "🌙"]
];
const MOOD_RATINGS = [
  { emoji: "😞", label: "Rough" }, { emoji: "😕", label: "Low" },
  { emoji: "😐", label: "Okay" }, { emoji: "🙂", label: "Good" },
  { emoji: "😄", label: "Great" }
];
const MOTIVATION_RATINGS = [
  { emoji: "🥱", label: "Drained" }, { emoji: "😐", label: "Slow" },
  { emoji: "🙂", label: "Steady" }, { emoji: "🔥", label: "Motivated" },
  { emoji: "🚀", label: "Unstoppable" }
];
const STORAGE_KEY = "simple-habit-tracker-v1";
const $ = (selector) => document.querySelector(selector);
let state = loadState();
let editingHabitId = null;
let activeChartView = "daily";
let lastDeletedHabit = null;
let deletionTimer = null;
let installPrompt = null;

function uid() { return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function monthKey(date = state.month) { return date; }
function todayMonth() { return new Date().toISOString().slice(0, 7); }
function initialState() {
  return { month: todayMonth(), habits: DEFAULT_HABITS.map(([name, icon]) => ({ id: uid(), name, icon })), entries: {}, checkins: {} };
}
function loadState() {
  try { return { ...initialState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) }; }
  catch { return initialState(); }
}
function saveState(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (options.sync === false || !window.habitCloud) return;
  // Send each completed action straight away. Delaying this lets an older cloud
  // snapshot briefly overwrite a check that the person has just unticked.
  window.habitCloud.save(JSON.parse(JSON.stringify(state)));
}
function daysInMonth() { const [y, m] = state.month.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function daysInMonthFor(month) { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function dateKey(day) { return `${state.month}-${String(day).padStart(2, "0")}`; }
function currentDateKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}
function weekOf(day) { return Math.ceil(day / 7); }
function formatMonth() { return new Date(`${state.month}-02T12:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" }); }
function completionForHabit(habit) { return Array.from({ length: daysInMonth() }, (_, i) => Boolean(state.entries[`${habit.id}:${dateKey(i + 1)}`])).filter(Boolean).length; }
function totalCompleted() { return state.habits.reduce((sum, h) => sum + completionForHabit(h), 0); }
function completedOn(day) { return state.habits.filter(h => state.entries[`${h.id}:${dateKey(day)}`]).length; }
function progressForDay(day) { return state.habits.length ? Math.round((completedOn(day) / state.habits.length) * 100) : 0; }
function currentStreak() {
  const isCurrentMonth = todayMonth() === state.month;
  let day = isCurrentMonth ? new Date().getDate() : daysInMonth(), streak = 0;
  while (day > 0 && completedOn(day) > 0) { streak += 1; day -= 1; }
  return streak;
}
function progressForMonth(month) {
  const goal = state.habits.length * daysInMonthFor(month);
  const completed = state.habits.reduce((total, habit) => total + Array.from({ length: daysInMonthFor(month) }, (_, i) => state.entries[`${habit.id}:${month}-${String(i + 1).padStart(2, "0")}`] ? 1 : 0).reduce((a, b) => a + b, 0), 0);
  return goal ? Math.round(completed / goal * 100) : 0;
}
function recentMonths() {
  const [year, month] = state.month.split("-").map(Number);
  return Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(year, month - 6 + index, 1)).toISOString().slice(0, 7));
}

function renderHabits() {
  $("#habitList").innerHTML = state.habits.map(h => `
    <div class="habit-item" data-habit-item="${h.id}" draggable="true">
      <button class="habit-drag" type="button" data-drag-handle="${h.id}" aria-label="Move ${escapeHtml(h.name)}. Use arrow keys or drag to reorder" title="Drag or use arrow keys to reorder">⠿</button>
      <button class="habit-name" data-edit="${h.id}"><span class="habit-emoji">${escapeHtml(h.icon)}</span><span>${escapeHtml(h.name)}</span></button>
      <button class="habit-action" data-edit="${h.id}" title="Edit habit" aria-label="Edit ${escapeHtml(h.name)}">✎</button>
      <button class="habit-action habit-delete" data-delete="${h.id}" title="Delete habit" aria-label="Delete ${escapeHtml(h.name)}">×</button>
    </div>`).join("");
}
function renderSuggestions() {
  $("#suggestionList").innerHTML = HABIT_SUGGESTIONS.map(([name, icon]) => `<button type="button" data-suggestion-name="${name}" data-suggestion-icon="${icon}">${icon} ${name}</button>`).join("");
}
function renderTracker() {
  const count = daysInMonth();
  const days = Array.from({ length: count }, (_, i) => i + 1);
  const [year, month] = state.month.split("-").map(Number);
  const labelDates = days.map(day => new Date(year, month - 1, day, 12));
  const weeks = [1, 2, 3, 4, 5, 6];
  const isCurrentMonth = todayMonth() === state.month;
  const currentDay = isCurrentMonth ? new Date().getDate() : -1;
  const weekCells = weeks.map(week => {
    const first = (week - 1) * 7 + 1, span = Math.min(7, count - first + 1);
    return span > 0 ? `<div style="grid-column: span ${span}">Week ${week}</div>` : "";
  }).join("");
  const dayClass = (date, day) => `${date.getDay() === 0 || date.getDay() === 6 ? "is-weekend" : ""} ${day === currentDay ? "is-today" : ""}`.trim();
  const dates = labelDates.map((date, index) => `<div class="${dayClass(date, index + 1)}" title="${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}" ${index + 1 === currentDay ? 'aria-current="date"' : ""}><span>${date.toLocaleDateString("en-US", { weekday: "short" }).slice(0,2)}</span><strong class="day-number">${index + 1}</strong></div>`).join("");
  const habitRows = state.habits.map(h => `<div class="grid-row habit-row" style="--days:${count}"><div class="habit-label"><span>${escapeHtml(h.icon)}</span>${escapeHtml(h.name)}</div>${days.map((day, index) => `<label class="cell ${dayClass(labelDates[index], day)}" title="${escapeHtml(h.name)} — day ${day}"><input type="checkbox" data-habit="${h.id}" data-day="${day}" aria-label="${escapeHtml(h.name)}, ${labelDates[index].toLocaleDateString(undefined, { month: "long", day: "numeric" })}" ${state.entries[`${h.id}:${dateKey(day)}`] ? "checked" : ""}/></label>`).join("")}</div>`).join("");
  $("#trackerGrid").innerHTML = `<div class="grid-row week-row" style="--days:${count}"><div class="corner"></div>${weekCells}</div><div class="grid-row date-row" style="--days:${count}"><div class="corner">My habits</div>${dates}</div>${habitRows || `<p style="padding:25px">Add your first habit to start tracking.</p>`}`;
  $("#trackerHeading").textContent = formatMonth();
}
function renderActivityChart() {
  const count = daysInMonth();
  const weeklyValues = Array.from({ length: Math.ceil(count / 7) }, (_, i) => i + 1).map(week => {
    const range = Array.from({ length: Math.min(7, count - (week - 1) * 7) }, (_, i) => progressForDay((week - 1) * 7 + i + 1));
    return Math.round(range.reduce((a, b) => a + b, 0) / range.length);
  });
  const graph = activeChartView === "daily"
    ? { title: "Daily activity", description: "How many habits you completed each day", values: Array.from({ length: count }, (_, i) => progressForDay(i + 1)), labels: Array.from({ length: count }, (_, i) => i + 1), stat: `${totalCompleted()} checks` }
    : activeChartView === "weekly"
      ? { title: "Weekly activity", description: "Your average completion rate for each week", values: weeklyValues, labels: weeklyValues.map((_, i) => `W${i + 1}`), stat: `${Math.round(weeklyValues.reduce((a, b) => a + b, 0) / weeklyValues.length) || 0}% average` }
      : { title: "Monthly activity", description: "Your completion rate across the last six months", values: recentMonths().map(progressForMonth), labels: recentMonths().map(month => new Date(`${month}-02T12:00:00`).toLocaleString("en-US", { month: "short" })), stat: `${progressForMonth(state.month)}% this month` };
  $("#activityChartTitle").textContent = graph.title;
  $("#activityChartDescription").textContent = graph.description;
  $("#activityChartStat").textContent = graph.stat;
  $("#activityChart").classList.toggle("is-empty", graph.values.every(value => value === 0));
  const chartWidth = 620, chartHeight = 96;
  const points = graph.values.map((value, index) => `${graph.values.length === 1 ? chartWidth / 2 : (index / (graph.values.length - 1)) * chartWidth},${chartHeight - (value / 100) * 78 - 8}`).join(" ");
  const areaPoints = `0,${chartHeight} ${points} ${chartWidth},${chartHeight}`;
  $("#activityChart").innerHTML = `<svg class="activity-trend" viewBox="0 0 ${chartWidth} ${chartHeight}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${areaPoints}"></polygon><polyline points="${points}"></polyline></svg>${graph.values.map((value, index) => `<div class="overview-bar-wrap ${value ? "has-progress" : ""}"><div class="overview-bar" style="height:${Math.max(value, 3)}%" title="${graph.labels[index]}: ${value}%"><i></i></div><span>${graph.labels[index]}</span></div>`).join("")}`;
  document.querySelectorAll("[data-chart-view]").forEach(button => button.classList.toggle("active", button.dataset.chartView === activeChartView));
}
function habitSparkline(habit) {
  const count = daysInMonth(), values = Array.from({ length: count }, (_, i) => state.entries[`${habit.id}:${dateKey(i + 1)}`] ? 1 : 0);
  const total = values.reduce((sum, value) => sum + value, 0), percent = count ? Math.round(total / count * 100) : 0;
  return `<div class="habit-line-row" title="${escapeHtml(habit.name)}: ${total} of ${count} days"><span class="habit-line-name"><span>${escapeHtml(habit.icon)}</span>${escapeHtml(habit.name)}</span><span class="habit-progress" role="img" aria-label="${escapeHtml(habit.name)} completed ${total} of ${count} days"><span class="habit-progress-fill" style="--progress:${percent}%"><i></i></span></span><strong>${percent}%</strong></div>`;
}
function renderHabitLines() {
  if (!state.habits.length) { $("#habitLines").innerHTML = "<p class='habit-empty'>Add your first habit to see its progress here.</p>"; return; }
  const emptyMessage = totalCompleted() === 0 ? "<p class='habit-empty'><span>✦</span> Your progress will glow here after the first check.</p>" : "";
  $("#habitLines").innerHTML = `${emptyMessage}${state.habits.map(habitSparkline).join("")}`;
}
function renderCharts() {
  const count = daysInMonth();
  const completed = totalCompleted(), goal = state.habits.length * count, percent = goal ? Math.round(completed / goal * 100) : 0;
  $("#donut").style.setProperty("--progress", `${percent * 3.6}deg`);
  $("#completionPercent").textContent = `${percent}%`; $("#goalCount").textContent = goal; $("#completedCount").textContent = completed; $("#leftCount").textContent = goal - completed;
  $("#streakCount").textContent = `${currentStreak()} ${currentStreak() === 1 ? "day" : "days"}`;
  renderActivityChart(); renderHabitLines();
}
function renderAnalysis() {
  const count = daysInMonth();
  const sorted = [...state.habits].map(h => ({ ...h, value: completionForHabit(h), percent: count ? Math.round(completionForHabit(h) / count * 100) : 0 })).sort((a,b) => b.value - a.value);
  $("#analysisList").innerHTML = sorted.slice(0, 7).map(h => `<div class="analysis-row"><span class="analysis-name">${escapeHtml(h.name)}</span><strong>${h.value}/${count}</strong><div class="analysis-track"><div class="analysis-fill" style="--progress:${h.percent}%"></div></div></div>`).join("") || "<p class='summary-text'>No habits added yet.</p>";
  $("#topHabits").innerHTML = sorted.slice(0, 10).map(h => `<li><span>${escapeHtml(h.name)} ${escapeHtml(h.icon)}</span><strong>${h.percent}%</strong></li>`).join("") || "<li><span>No habits yet</span></li>";
}
function renderRatings() {
  const current = state.checkins[currentDateKey()] || {};
  renderRating("mood", current.mood); renderRating("motivation", current.motivation);
  $("#moodValue").textContent = current.mood ? MOOD_RATINGS[current.mood - 1].emoji : "—";
  $("#motivationValue").textContent = current.motivation ? MOTIVATION_RATINGS[current.motivation - 1].emoji : "—";
  const selections = [
    current.mood && `Mood: ${MOOD_RATINGS[current.mood - 1].emoji} ${MOOD_RATINGS[current.mood - 1].label}`,
    current.motivation && `Motivation: ${MOTIVATION_RATINGS[current.motivation - 1].emoji} ${MOTIVATION_RATINGS[current.motivation - 1].label}`
  ].filter(Boolean);
  $("#checkinSummary").textContent = selections.length ? `Saved today — ${selections.join(" · ")}` : "No mood or motivation saved for today yet.";
}
function renderRating(type, value) {
  const ratings = type === "mood" ? MOOD_RATINGS : MOTIVATION_RATINGS;
  $(`#${type}Choices`).innerHTML = ratings.map((rating, index) => `<button data-rating="${type}" data-value="${index + 1}" class="${value === index + 1 ? "active" : ""}" title="${rating.label}" aria-label="${rating.label} ${type}">${rating.emoji}</button>`).join("");
}
function render() { $("#monthPicker").value = state.month; $("#monthTitle").textContent = formatMonth(); renderHabits(); renderTracker(); renderCharts(); renderAnalysis(); renderRatings(); }
function changeMonth(offset) { const [year, month] = state.month.split("-").map(Number); state.month = new Date(year, month - 1 + offset, 1).toISOString().slice(0, 7); saveState(); render(); }
function escapeHtml(value = "") { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function hideUndoToast() { $("#undoToast").classList.remove("visible"); }
function deleteHabit(id) {
  const index = state.habits.findIndex(habit => habit.id === id);
  if (index < 0) return;
  const habit = state.habits[index];
  const entries = Object.fromEntries(Object.entries(state.entries).filter(([key]) => key.startsWith(`${habit.id}:`)));
  state.habits.splice(index, 1);
  Object.keys(entries).forEach(key => delete state.entries[key]);
  lastDeletedHabit = { habit, entries, index };
  clearTimeout(deletionTimer);
  $("#undoToastMessage").textContent = `“${habit.name}” deleted`;
  $("#undoToast").classList.add("visible");
  deletionTimer = setTimeout(() => { lastDeletedHabit = null; hideUndoToast(); }, 5500);
  saveState(); render();
}
function undoDelete() {
  if (!lastDeletedHabit) return;
  const { habit, entries, index } = lastDeletedHabit;
  state.habits.splice(index, 0, habit);
  Object.assign(state.entries, entries);
  lastDeletedHabit = null; clearTimeout(deletionTimer); hideUndoToast(); saveState(); render();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target.closest("[data-close-dialog]")) { $("#habitDialog").close(); return; }
  const suggestion = target.closest("[data-suggestion-name]");
  if (suggestion) { $("#habitName").value = suggestion.dataset.suggestionName; $("#habitIcon").value = suggestion.dataset.suggestionIcon; $("#habitName").focus(); return; }
  const chartView = target.closest("[data-chart-view]");
  if (chartView) { activeChartView = chartView.dataset.chartView; renderActivityChart(); return; }
  if (target.closest("#undoDelete")) { undoDelete(); return; }
  if (target.matches("[data-habit]")) { const key = `${target.dataset.habit}:${dateKey(Number(target.dataset.day))}`; if (target.checked) state.entries[key] = true; else delete state.entries[key]; saveState(); renderCharts(); renderAnalysis(); return; }
  if (target.matches("[data-rating]")) { const today = currentDateKey(); state.checkins[today] = { ...(state.checkins[today] || {}), [target.dataset.rating]: Number(target.dataset.value) }; saveState(); renderRatings(); return; }
  const edit = target.closest("[data-edit]"); if (edit) { openHabitDialog(edit.dataset.edit); return; }
  const remove = target.closest("[data-delete]"); if (remove) deleteHabit(remove.dataset.delete);
});
let draggedHabitId = null;
document.addEventListener("dragstart", (event) => {
  const item = event.target.closest("[data-habit-item]");
  if (!item) return;
  draggedHabitId = item.dataset.habitItem;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedHabitId);
  item.classList.add("dragging");
});
document.addEventListener("dragover", (event) => {
  const item = event.target.closest("[data-habit-item]");
  if (!item || item.dataset.habitItem === draggedHabitId) return;
  event.preventDefault();
  document.querySelectorAll(".drop-target").forEach(target => target.classList.remove("drop-target"));
  item.classList.add("drop-target");
});
document.addEventListener("dragleave", (event) => event.target.closest("[data-habit-item]")?.classList.remove("drop-target"));
document.addEventListener("drop", (event) => {
  const item = event.target.closest("[data-habit-item]");
  if (!item || !draggedHabitId || item.dataset.habitItem === draggedHabitId) return;
  event.preventDefault();
  const fromIndex = state.habits.findIndex(habit => habit.id === draggedHabitId);
  const toIndex = state.habits.findIndex(habit => habit.id === item.dataset.habitItem);
  if (fromIndex < 0 || toIndex < 0) return;
  [state.habits[fromIndex], state.habits[toIndex]] = [state.habits[toIndex], state.habits[fromIndex]];
  saveState();
  render();
});
document.addEventListener("dragend", () => {
  draggedHabitId = null;
  document.querySelectorAll(".dragging, .drop-target").forEach(item => item.classList.remove("dragging", "drop-target"));
});
document.addEventListener("keydown", (event) => {
  const handle = event.target.closest("[data-drag-handle]");
  if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const index = state.habits.findIndex(habit => habit.id === handle.dataset.dragHandle);
  const destination = event.key === "ArrowUp" ? index - 1 : index + 1;
  if (index < 0 || destination < 0 || destination >= state.habits.length) return;
  [state.habits[index], state.habits[destination]] = [state.habits[destination], state.habits[index]];
  saveState();
  render();
  document.querySelector(`[data-drag-handle="${handle.dataset.dragHandle}"]`)?.focus();
});
$("#addHabit").addEventListener("click", () => openHabitDialog());
$("#previousMonth").addEventListener("click", () => changeMonth(-1)); $("#nextMonth").addEventListener("click", () => changeMonth(1));
$("#monthPicker").addEventListener("change", event => { state.month = event.target.value || state.month; saveState(); render(); });
$("#clearMonth").addEventListener("click", () => { if (confirm(`Clear all checked habits for ${formatMonth()}?`)) { Object.keys(state.entries).filter(key => key.endsWith(`:${state.month}`) || key.includes(`:${state.month}-`)).forEach(key => delete state.entries[key]); saveState(); render(); } });
function openHabitDialog(id = null) {
  editingHabitId = id;
  const habit = state.habits.find(h => h.id === id);
  $("#dialogTitle").textContent = habit ? "Edit habit" : "New habit";
  $("#habitName").value = habit?.name || ""; $("#habitIcon").value = habit?.icon || "";
  $("#habitSuggestions").hidden = Boolean(habit);
  renderSuggestions(); $("#habitDialog").showModal();
}
$("#habitForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("#habitName").value.trim(), icon = $("#habitIcon").value.trim();
  if (!name) return;
  if (editingHabitId) { const habit = state.habits.find(h => h.id === editingHabitId); Object.assign(habit, { name, icon }); }
  else state.habits.push({ id: uid(), name, icon });
  saveState(); $("#habitDialog").close(); render();
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  $("#installApp").hidden = false;
});
$("#installApp").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#installApp").hidden = true;
});
window.addEventListener("appinstalled", () => { installPrompt = null; $("#installApp").hidden = true; });
window.addEventListener("habit-cloud-state", event => {
  if (event.detail?.reset) {
    state = initialState();
    saveState({ sync: false });
    render();
    return;
  }
  const cloudState = event.detail?.state;
  if (!cloudState || !Array.isArray(cloudState.habits)) return;
  state = {
    ...initialState(),
    ...cloudState,
    habits: cloudState.habits,
    entries: cloudState.entries || {},
    checkins: cloudState.checkins || {}
  };
  saveState({ sync: false });
  render();
});
window.getHabitTrackerState = () => JSON.parse(JSON.stringify(state));
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));
render();
