import { auth } from "./firebase-sync.js";
import { NutritionRepository } from "./nutrition-data.js";
import { aiNutritionService, compressFoodPhoto } from "./nutrition-ai.js";
import {
  ACTIVITY_LEVELS,
  buildDailySeries,
  calculateNutritionTargets,
  clampNumber,
  dayTotals,
  displayWeight,
  localDateKey,
  mealTotals,
  normalizeFood,
  shiftDateKey,
  targetPercent,
  weightToKg
} from "./nutrition-calculations.js";

const root = document.querySelector("#caloriesModule");
const habitModule = document.querySelector("#habitModule");
const moduleNav = document.querySelector("#moduleNav");
const MEAL_TYPES = ["breakfast", "lunch", "snacks", "dinner"];
const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", snacks: "Snacks", dinner: "Dinner" };
let repository = null;
let nutrition = emptyNutrition();
let selectedDate = localDateKey();
let activeModule = location.hash.slice(1) || "habits";
let foodMode = "menu";
let reviewMeal = null;
let reviewSource = null;
let photoPayload = null;
let onboardingStep = 1;
let onboardingDraft = null;
let progressDays = 7;
let aiStatus = { configured: false, provider: "Checking…", model: "Checking…" };
let toastTimer = null;

function emptyNutrition() {
  return { profile: null, mealLogs: [], waterLogs: [], weightLogs: [], favoriteMeals: [], mealPlans: [], dailyNotes: [], deletions: [] };
}

function escapeHtml(value = "") {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function id(prefix = "item") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function formatDate(key, options = { weekday: "long", month: "short", day: "numeric" }) { return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, options); }
function mealsForDate(key = selectedDate) { return nutrition.mealLogs.filter(meal => meal.date === key).sort((a, b) => String(a.time || "").localeCompare(String(b.time || ""))); }
function waterForDate(key = selectedDate) { return nutrition.waterLogs.filter(log => log.date === key); }
function currentTotals(key = selectedDate) { return dayTotals(mealsForDate(key), waterForDate(key)); }
function percent(value, target) { return Math.min(100, targetPercent(value, target)); }

function shellTemplate() {
  return `
    <div class="calories-topbar">
      <div><p class="eyebrow">PERSONAL NUTRITION</p><h1 id="nutritionViewTitle">Calories Tracker</h1></div>
      <div class="nutrition-sync"><i class="${repository?.online ? "online" : ""}"></i><span>${repository?.online ? "Synced" : "Offline-ready"}</span></div>
    </div>
    <section id="nutritionContent" class="nutrition-content"></section>
    <button id="mobileAddFood" class="mobile-add-food" type="button">＋ Add food</button>
    <div id="nutritionToast" class="nutrition-toast" role="status" aria-live="polite"></div>
  `;
}

function ensureDialogs() {
  if (document.querySelector("#foodDialog")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <dialog id="foodDialog" class="nutrition-dialog"><div id="foodDialogContent"></div></dialog>
    <dialog id="nutritionOnboarding" class="nutrition-dialog onboarding-dialog"><div id="onboardingContent"></div></dialog>
  `);
}

function showToast(message, tone = "success") {
  const toast = document.querySelector("#nutritionToast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3400);
}

function setModule(moduleName, updateHash = true) {
  activeModule = moduleName;
  const isHabit = moduleName === "habits";
  habitModule.hidden = !isHabit;
  root.hidden = isHabit;
  document.body.classList.toggle("nutrition-active", !isHabit);
  moduleNav.querySelectorAll("[data-module]").forEach(button => button.classList.toggle("active", button.dataset.module === moduleName));
  if (updateHash) history.replaceState(null, "", `#${moduleName}`);
  if (!isHabit) renderNutrition();
}

async function connectNutrition(user) {
  repository?.destroy();
  repository = new NutritionRepository(user.uid);
  nutrition = repository.snapshot();
  repository.addEventListener("change", event => { nutrition = event.detail.state; if (activeModule !== "habits") renderNutrition(); });
  renderNutrition();
  repository.sync().catch(() => showToast("Using your offline nutrition copy.", "info"));
  aiNutritionService.status().then(status => { aiStatus = status || { configured: false, provider: "Not configured", model: "Not configured" }; if (activeModule === "nutrition-settings") renderNutrition(); }).catch(error => { aiStatus = { configured: false, provider: "Unavailable", model: "Unavailable", message: error.message }; });
}

function disconnectNutrition() {
  repository?.destroy();
  repository = null;
  nutrition = emptyNutrition();
  renderNutrition();
}

moduleNav.addEventListener("click", event => {
  const button = event.target.closest("[data-module]");
  if (button) setModule(button.dataset.module);
});
window.addEventListener("hashchange", () => setModule(location.hash.slice(1) || "habits", false));
window.addEventListener("health-auth-changed", event => event.detail.authorized && event.detail.user ? connectNutrition(event.detail.user) : disconnectNutrition());

root.innerHTML = shellTemplate();
ensureDialogs();
if (window.healthAuth?.authorized && window.healthAuth.currentUser) connectNutrition(window.healthAuth.currentUser);
setModule(["habits", "calories", "planner", "progress", "nutrition-settings"].includes(activeModule) ? activeModule : "habits", false);

function renderNutrition() {
  const content = document.querySelector("#nutritionContent");
  if (!content) return;
  document.querySelector("#mobileAddFood").hidden = activeModule !== "calories" || !nutrition.profile;
  document.querySelector("#nutritionViewTitle").textContent = activeModule === "planner" ? "Meal Planner" : activeModule === "progress" ? "Progress" : activeModule === "nutrition-settings" ? "Nutrition Settings" : "Calories Tracker";
  const sync = document.querySelector(".nutrition-sync");
  if (sync) sync.innerHTML = `<i class="${repository?.online ? "online" : ""}"></i><span>${repository?.online ? "Synced" : "Offline-ready"}</span>`;
  if (!repository) {
    content.innerHTML = `<section class="nutrition-locked"><span>◉</span><h2>Sign in to open Calories Tracker</h2><p>Your nutrition data belongs to the same approved account as your habits.</p><button type="button" data-go-habits>Return to Habit Tracker</button></section>`;
    return;
  }
  if (!nutrition.profile) {
    content.innerHTML = `<section class="nutrition-locked"><span>◎</span><h2>Set up your nutrition targets</h2><p>A short, guided setup will calculate a practical starting point for calories, protein, and water.</p><button type="button" data-start-onboarding>Start setup</button></section>`;
    renderOnboarding();
    const dialog = document.querySelector("#nutritionOnboarding");
    if (!dialog.open) dialog.showModal();
    return;
  }
  if (activeModule === "planner") content.innerHTML = plannerTemplate();
  else if (activeModule === "progress") content.innerHTML = progressTemplate();
  else if (activeModule === "nutrition-settings") content.innerHTML = settingsTemplate();
  else content.innerHTML = dashboardTemplate();
}

function dashboardTemplate() {
  const profile = nutrition.profile;
  const totals = currentTotals();
  const remaining = profile.calorieTarget - totals.calories;
  const caloriePercent = targetPercent(totals.calories, profile.calorieTarget);
  const today = selectedDate === localDateKey();
  const latestWeight = [...nutrition.weightLogs].sort((a, b) => b.date.localeCompare(a.date))[0];
  return `
    <div class="date-navigator">
      <button type="button" data-shift-date="-1" aria-label="Previous day">‹</button>
      <div><strong>${today ? "Today" : formatDate(selectedDate, { weekday: "long" })}</strong><span>${formatDate(selectedDate, { month: "long", day: "numeric", year: "numeric" })}</span></div>
      <button type="button" data-shift-date="1" aria-label="Next day" ${selectedDate >= localDateKey() ? "disabled" : ""}>›</button>
    </div>
    <section class="nutrition-dashboard-grid">
      <div class="nutrition-main-column">
        <article class="calorie-hero nutrition-card ${remaining < 0 ? "is-over" : ""}">
          <div class="calorie-ring" style="--calorie-progress:${Math.min(caloriePercent, 100) * 3.6}deg"><div><span>Consumed</span><strong>${totals.calories.toLocaleString()}</strong><small>kcal</small></div></div>
          <div class="calorie-hero-copy"><p class="eyebrow">TODAY'S ENERGY</p><h2>${remaining >= 0 ? `${remaining.toLocaleString()} kcal remaining` : `${Math.abs(remaining).toLocaleString()} kcal over target`}</h2><p>${remaining >= 0 ? "Keep building your day with food that feels good and supports your target." : "One higher-calorie day does not require extreme compensation. Continue normally tomorrow."}</p><div class="calorie-stats"><span><b>${profile.calorieTarget.toLocaleString()}</b> target</span><span><b>${caloriePercent}%</b> complete</span></div></div>
        </article>
        <section class="macro-grid">
          ${macroCard("Protein", totals.protein, profile.proteinTarget, "g", "protein")}
          ${macroCard("Carbs", totals.carbs, profile.carbsTarget, "g", "carbs")}
          ${macroCard("Fat", totals.fat, profile.fatTarget, "g", "fat")}
        </section>
        <article class="nutrition-card meals-card">
          <div class="nutrition-card-heading"><div><p class="eyebrow">DAILY LOG</p><h2>Today's meals</h2></div><button class="primary-action" type="button" data-open-food>＋ Add food</button></div>
          <div class="meal-sections">${MEAL_TYPES.map(type => mealSection(type)).join("")}</div>
        </article>
      </div>
      <aside class="nutrition-side-column">
        <article class="nutrition-card water-card">
          <div class="nutrition-card-heading"><div><p class="eyebrow">HYDRATION</p><h2>Water</h2></div><strong>${(totals.waterMl / 1000).toFixed(1)} / ${(profile.waterTargetMl / 1000).toFixed(1)} L</strong></div>
          <div class="water-visual"><i style="--water:${percent(totals.waterMl, profile.waterTargetMl)}%"></i></div>
          <div class="water-actions"><button type="button" data-add-water="250">+250 ml</button><button type="button" data-add-water="500">+500 ml</button><button type="button" data-custom-water>Custom</button></div>
          ${waterForDate().length ? `<button class="quiet-action" type="button" data-undo-water>Undo last water</button>` : ""}
        </article>
        <article class="nutrition-card quick-actions-card"><p class="eyebrow">QUICK ACTIONS</p><h2>Log in seconds</h2><div class="quick-action-grid"><button type="button" data-food-mode="photo"><span>⌁</span>Food photo</button><button type="button" data-food-mode="text"><span>✦</span>Describe meal</button><button type="button" data-food-mode="quick"><span>＋</span>Quick add</button><button type="button" data-log-weight><span>↗</span>Log weight</button></div></article>
        <article class="nutrition-card weight-mini"><div class="nutrition-card-heading"><div><p class="eyebrow">WEIGHT</p><h2>${latestWeight ? displayWeight(latestWeight.weightKg, profile.units) : "No entries yet"}</h2></div><button type="button" data-log-weight>${latestWeight ? "Update" : "Log"}</button></div>${latestWeight ? `<p>Last logged ${formatDate(latestWeight.date, { month: "short", day: "numeric" })}</p>` : `<p>Track trends without overreacting to daily fluctuations.</p>`}</article>
        <article class="nutrition-card suggestion-card"><p class="eyebrow">NEXT BEST STEP</p><h2>What should I eat?</h2><p>Get practical suggestions based on your remaining calories, protein, preferences, and today's meals.</p><button type="button" data-what-eat>Get suggestions</button></article>
        <article class="nutrition-card note-card"><div class="nutrition-card-heading"><h2>Daily note</h2><span>Optional</span></div><textarea id="dailyNote" maxlength="240" placeholder="Gym day, travel, felt hungry…">${escapeHtml(nutrition.dailyNotes.find(note => note.id === selectedDate)?.text || "")}</textarea><button type="button" data-save-note>Save note</button></article>
      </aside>
    </section>`;
}

function macroCard(label, value, target, unit, tone) {
  const valueText = Number(value || 0).toFixed(value % 1 ? 1 : 0);
  return `<article class="nutrition-card macro-card ${tone}"><div><span>${label}</span><strong>${valueText}<small> / ${target}${unit}</small></strong></div><div class="macro-track"><i style="--macro:${percent(value, target)}%"></i></div></article>`;
}

function mealSection(type) {
  const meals = mealsForDate().filter(meal => meal.mealType === type);
  const total = meals.reduce((sum, meal) => sum + mealTotals(meal.foods).calories, 0);
  return `<section class="meal-section"><div class="meal-section-title"><div><span class="meal-icon">${{ breakfast: "☀", lunch: "◐", snacks: "✦", dinner: "☾" }[type]}</span><strong>${MEAL_LABELS[type]}</strong><small>${total} kcal</small></div><button type="button" data-add-to-meal="${type}" aria-label="Add ${MEAL_LABELS[type]}">＋</button></div><div class="meal-list">${meals.length ? meals.map(mealCard).join("") : `<button class="empty-meal" type="button" data-add-to-meal="${type}">No food logged · Add something</button>`}</div></section>`;
}

function mealCard(meal) {
  const totals = mealTotals(meal.foods);
  return `<article class="meal-item ${meal.treatMeal ? "treat" : ""}"><div class="meal-item-main"><strong>${escapeHtml(meal.mealName || meal.foods.map(food => food.name).join(" + "))}</strong><span>${meal.foods.map(food => escapeHtml(food.name)).join(" · ")}</span><small>${totals.protein}g protein · ${totals.carbs}g carbs · ${totals.fat}g fat ${meal.aiEstimated ? `· ${escapeHtml(meal.overallConfidence || "medium")} confidence` : ""}</small></div><b>${totals.calories}<small> kcal</small></b><div class="meal-menu"><button type="button" data-edit-meal="${meal.id}" aria-label="Edit meal">Edit</button><button type="button" data-favorite-meal="${meal.id}" aria-label="Save favorite">♡</button><button type="button" data-delete-meal="${meal.id}" aria-label="Delete meal">×</button></div></article>`;
}

function plannerTemplate() {
  const upcoming = [...nutrition.mealPlans].sort((a, b) => `${a.date}${a.mealType}`.localeCompare(`${b.date}${b.mealType}`));
  return `<section class="planner-layout">
    <article class="nutrition-card cook-card"><div><p class="eyebrow">AI KITCHEN</p><h2>What can I cook?</h2><p>Tell us what you have. Suggestions consider your targets and nutrition preferences.</p></div><form id="cookForm"><label>Available ingredients<textarea name="ingredients" required placeholder="Eggs, rice, onion, tomato, soya chunks…"></textarea></label><div class="form-pair"><label>Time available<input name="minutes" type="number" min="5" max="180" value="20" inputmode="numeric" /></label><label>Meal<select name="mealType"><option value="lunch">Lunch</option><option value="dinner">Dinner</option><option value="breakfast">Breakfast</option><option value="snacks">Snacks</option></select></label></div><button class="primary-action" type="submit">✦ Generate ideas</button></form><div id="cookResults" class="suggestion-results"></div></article>
    <article class="nutrition-card plan-card"><div class="nutrition-card-heading"><div><p class="eyebrow">UPCOMING</p><h2>Meal plan</h2></div><button type="button" data-create-plan>＋ Plan meal</button></div><div class="plan-list">${upcoming.length ? upcoming.map(planCard).join("") : `<div class="nutrition-empty"><span>▦</span><h3>No meals planned</h3><p>Plan a meal now, then mark it eaten when the time comes.</p><button type="button" data-create-plan>Plan your first meal</button></div>`}</div></article>
    <article class="nutrition-card favorites-library"><div class="nutrition-card-heading"><div><p class="eyebrow">SAVED</p><h2>Favorite meals</h2></div><span>${nutrition.favoriteMeals.length}</span></div><div>${nutrition.favoriteMeals.length ? nutrition.favoriteMeals.map(favoriteCard).join("") : `<p class="muted-copy">Save a meal as a favorite to repeat it quickly.</p>`}</div></article>
  </section>`;
}

function planCard(plan) {
  return `<article class="plan-item"><div class="plan-date"><strong>${new Date(`${plan.date}T12:00:00`).getDate()}</strong><span>${formatDate(plan.date, { month: "short" })}</span></div><div><small>${escapeHtml(MEAL_LABELS[plan.mealType] || plan.mealType)}</small><strong>${escapeHtml(plan.mealName)}</strong><span>${Math.round(plan.calories || 0)} kcal · ${Number(plan.protein || 0)}g protein${plan.preparationMinutes ? ` · ${plan.preparationMinutes} min` : ""}</span></div><div class="plan-actions"><button type="button" data-eat-plan="${plan.id}">Mark eaten</button><button type="button" data-delete-plan="${plan.id}" aria-label="Remove planned meal">×</button></div></article>`;
}

function favoriteCard(favorite) {
  const totals = mealTotals(favorite.foods);
  return `<article class="favorite-item"><div><strong>${escapeHtml(favorite.name || favorite.mealName)}</strong><span>${totals.calories} kcal · ${totals.protein}g protein</span></div><button type="button" data-add-favorite="${favorite.id}">Add today</button><button type="button" data-delete-favorite="${favorite.id}" aria-label="Delete favorite">×</button></article>`;
}

function progressTemplate() {
  const profile = nutrition.profile;
  const series = buildDailySeries(nutrition.mealLogs, nutrition.waterLogs, profile, progressDays);
  const daysWithMeals = series.filter(day => day.calories > 0);
  const averageCalories = daysWithMeals.length ? Math.round(daysWithMeals.reduce((sum, day) => sum + day.calories, 0) / daysWithMeals.length) : 0;
  const proteinDays = series.filter(day => day.proteinTarget && day.protein >= day.proteinTarget).length;
  const waterDays = series.filter(day => day.waterTargetMl && day.waterMl >= day.waterTargetMl).length;
  const withinTarget = series.filter(day => day.calories > 0 && Math.abs(day.calories - day.calorieTarget) <= day.calorieTarget * .1).length;
  const weights = [...nutrition.weightLogs].sort((a, b) => a.date.localeCompare(b.date));
  const weightChange = weights.length > 1 ? weights[weights.length - 1].weightKg - weights[0].weightKg : 0;
  return `<section class="progress-layout">
    <div class="progress-toolbar"><div><p class="eyebrow">YOUR TRENDS</p><h2>Progress, without the noise</h2></div><div class="range-switcher"><button data-progress-days="7" class="${progressDays === 7 ? "active" : ""}">7 days</button><button data-progress-days="30" class="${progressDays === 30 ? "active" : ""}">30 days</button><button data-progress-days="90" class="${progressDays === 90 ? "active" : ""}">3 months</button></div></div>
    <section class="insight-grid"><article class="nutrition-card insight-card"><span>Average calories</span><strong>${averageCalories.toLocaleString()} <small>kcal</small></strong><p>${daysWithMeals.length} logged ${daysWithMeals.length === 1 ? "day" : "days"}</p></article><article class="nutrition-card insight-card protein"><span>Protein target</span><strong>${proteinDays}<small> / ${progressDays} days</small></strong><p>Consistency matters more than perfection.</p></article><article class="nutrition-card insight-card water"><span>Water target</span><strong>${waterDays}<small> / ${progressDays} days</small></strong><p>Based on recorded water.</p></article><article class="nutrition-card insight-card"><span>Within target range</span><strong>${withinTarget}<small> days</small></strong><p>Within approximately 10%.</p></article></section>
    <section class="progress-charts"><article class="nutrition-card trend-card"><div class="nutrition-card-heading"><div><p class="eyebrow">ENERGY</p><h2>Daily calories</h2></div><span>Target ${profile.calorieTarget}</span></div>${barChart(series, "calories", profile.calorieTarget, "kcal")}</article><article class="nutrition-card trend-card"><div class="nutrition-card-heading"><div><p class="eyebrow">PROTEIN</p><h2>Daily protein</h2></div><span>Target ${profile.proteinTarget}g</span></div>${barChart(series, "protein", profile.proteinTarget, "g")}</article></section>
    <section class="progress-bottom"><article class="nutrition-card weight-chart-card"><div class="nutrition-card-heading"><div><p class="eyebrow">WEIGHT</p><h2>Weight trend</h2></div><button type="button" data-log-weight>＋ Log weight</button></div>${weightChart(weights, profile)}${weights.length > 1 ? `<p class="chart-caption">${weightChange > 0 ? "+" : ""}${weightChange.toFixed(1)} kg across your recorded period. Daily fluctuations are normal.</p>` : ""}</article><article class="nutrition-card smart-insights"><p class="eyebrow">SMART INSIGHTS</p><h2>This period</h2><ul><li>Your average intake was <strong>${averageCalories.toLocaleString()} kcal</strong> on logged days.</li><li>You reached your protein target on <strong>${proteinDays} of ${progressDays} days</strong>.</li><li>You reached your water target on <strong>${waterDays} of ${progressDays} days</strong>.</li><li>${daysWithMeals.length ? `Dinner contributed about <strong>${dinnerShare(series)}%</strong> of logged calories.` : "Log meals to unlock meal-pattern insights."}</li></ul></article></section>
  </section>`;
}

function barChart(series, key, target, unit) {
  const max = Math.max(target * 1.25, ...series.map(day => day[key]), 1);
  return `<div class="nutrition-bar-chart" role="img" aria-label="${key} over ${series.length} days">${series.map(day => `<div title="${formatDate(day.date)}: ${day[key]} ${unit}"><i style="--bar:${Math.min(100, day[key] / max * 100)}%"></i><span>${series.length <= 7 ? formatDate(day.date, { weekday: "short" }).slice(0, 2) : new Date(`${day.date}T12:00:00`).getDate()}</span></div>`).join("")}<b style="--target:${Math.min(100, target / max * 100)}%"></b></div>`;
}

function weightChart(weights, profile) {
  if (!weights.length) return `<div class="nutrition-empty compact"><span>↗</span><h3>No weight history yet</h3><button type="button" data-log-weight>Log weight</button></div>`;
  const recent = weights.slice(-12);
  const values = recent.map(item => item.weightKg);
  const min = Math.min(...values) - 1, max = Math.max(...values) + 1;
  const points = recent.map((entry, index) => `${recent.length === 1 ? 50 : index / (recent.length - 1) * 100},${90 - ((entry.weightKg - min) / Math.max(1, max - min)) * 70}`).join(" ");
  return `<div class="weight-chart" role="img" aria-label="Weight trend"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${points}"></polyline></svg><div><strong>${displayWeight(values[0], profile.units)}</strong><span>to</span><strong>${displayWeight(values[values.length - 1], profile.units)}</strong></div></div>`;
}

function dinnerShare(series) {
  const dateSet = new Set(series.map(day => day.date));
  const logged = nutrition.mealLogs.filter(meal => dateSet.has(meal.date));
  const all = logged.reduce((sum, meal) => sum + mealTotals(meal.foods).calories, 0);
  const dinners = logged.filter(meal => meal.mealType === "dinner").reduce((sum, meal) => sum + mealTotals(meal.foods).calories, 0);
  return all ? Math.round(dinners / all * 100) : 0;
}

function settingsTemplate() {
  const profile = nutrition.profile;
  return `<section class="settings-layout"><form id="nutritionSettingsForm" class="nutrition-card settings-form"><div class="nutrition-card-heading"><div><p class="eyebrow">HEALTH PROFILE</p><h2>Your targets</h2></div><button type="submit" class="primary-action">Save changes</button></div><p class="form-intro">Changes can recalculate future targets. Your historical meals and past progress are never rewritten.</p><div class="settings-grid">
    <label>Age<input name="age" type="number" min="13" max="100" value="${profile.age}" required inputmode="numeric" /></label>
    <label>Formula sex<select name="formulaSex"><option value="female" ${profile.formulaSex === "female" ? "selected" : ""}>Female</option><option value="male" ${profile.formulaSex === "male" ? "selected" : ""}>Male</option></select></label>
    <label>Height (${profile.units === "imperial" ? "in" : "cm"})<input name="height" type="number" min="36" step=".1" value="${profile.height}" required inputmode="decimal" /></label>
    <label>Current weight (${profile.units === "imperial" ? "lb" : "kg"})<input name="weight" type="number" min="30" step=".1" value="${profile.weight}" required inputmode="decimal" /></label>
    <label>Units<select name="units"><option value="metric" ${profile.units === "metric" ? "selected" : ""}>Metric</option><option value="imperial" ${profile.units === "imperial" ? "selected" : ""}>Imperial</option></select></label>
    <label>Activity<select name="activityLevel">${Object.entries(ACTIVITY_LEVELS).map(([key, value]) => `<option value="${key}" ${profile.activityLevel === key ? "selected" : ""}>${value.label}</option>`).join("")}</select></label>
    <label>Goal<select name="goalType"><option value="lose" ${profile.goalType === "lose" ? "selected" : ""}>Lose weight</option><option value="maintain" ${profile.goalType === "maintain" ? "selected" : ""}>Maintain weight</option><option value="gain" ${profile.goalType === "gain" ? "selected" : ""}>Gain weight</option></select></label>
    <label>Target weight<input name="targetWeight" type="number" step=".1" value="${profile.targetWeight || profile.weight}" inputmode="decimal" /></label>
    <label>Diet preference<select name="dietPreference"><option value="mixed" ${profile.dietPreference === "mixed" ? "selected" : ""}>Mixed</option><option value="vegetarian" ${profile.dietPreference === "vegetarian" ? "selected" : ""}>Vegetarian</option><option value="non-vegetarian" ${profile.dietPreference === "non-vegetarian" ? "selected" : ""}>Non-vegetarian</option><option value="eggetarian" ${profile.dietPreference === "eggetarian" ? "selected" : ""}>Eggetarian</option></select></label>
    <label>Daily calories<input name="calorieTarget" type="number" min="1000" max="6000" value="${profile.calorieTarget}" inputmode="numeric" /></label>
    <label>Protein target (g)<input name="proteinTarget" type="number" min="20" max="400" value="${profile.proteinTarget}" inputmode="numeric" /></label>
    <label>Water target (ml)<input name="waterTargetMl" type="number" min="500" max="10000" step="100" value="${profile.waterTargetMl}" inputmode="numeric" /></label>
    <label class="wide">Allergies<input name="allergies" value="${escapeHtml(profile.allergies || "")}" placeholder="e.g. peanuts, shellfish" /></label><label class="wide">Foods to avoid<input name="foodsToAvoid" value="${escapeHtml(profile.foodsToAvoid || "")}" placeholder="e.g. mushrooms" /></label></div><button type="button" class="recalculate-button" data-recalculate-targets>Recalculate recommended targets</button></form>
    <article class="nutrition-card ai-settings"><div class="ai-status-mark ${aiStatus.configured ? "connected" : ""}">${aiStatus.configured ? "✓" : "!"}</div><p class="eyebrow">AI NUTRITION</p><h2>${aiStatus.configured ? "Connected" : "Not configured"}</h2><dl><div><dt>Provider</dt><dd>${escapeHtml(aiStatus.provider)}</dd></div><div><dt>Model</dt><dd>${escapeHtml(aiStatus.model)}</dd></div><div><dt>Secret</dt><dd>Stored server-side</dd></div></dl><p>${aiStatus.message ? escapeHtml(aiStatus.message) : "AI keys are never sent to this browser."}</p><button type="button" data-test-ai ${!aiStatus.configured ? "disabled" : ""}>Test AI connection</button></article>
  </section>`;
}

function defaultProfileDraft() {
  return { age: 25, formulaSex: "male", height: 170, weight: 70, units: "metric", activityLevel: "moderate", goalType: "maintain", goalIntensity: "normal", targetWeight: 70, dietPreference: "mixed", allergies: "", foodsToAvoid: "", dislikedFoods: "" };
}

function renderOnboarding() {
  onboardingDraft ||= defaultProfileDraft();
  const target = document.querySelector("#onboardingContent");
  const targets = calculateNutritionTargets(onboardingDraft);
  const steps = ["About you", "Lifestyle", "Goal", "Preferences", "Targets", "Ready"];
  let body = "";
  if (onboardingStep === 1) body = `<div class="onboarding-fields"><label>Age<input name="age" type="number" min="13" max="100" value="${onboardingDraft.age}" required inputmode="numeric" /></label><label>Measurement system<select name="units"><option value="metric" ${onboardingDraft.units === "metric" ? "selected" : ""}>Metric — kg, cm</option><option value="imperial" ${onboardingDraft.units === "imperial" ? "selected" : ""}>Imperial — lb, in</option></select></label><label>Sex used by the calorie formula<select name="formulaSex"><option value="male" ${onboardingDraft.formulaSex === "male" ? "selected" : ""}>Male</option><option value="female" ${onboardingDraft.formulaSex === "female" ? "selected" : ""}>Female</option></select><small>This is used only for the Mifflin–St Jeor estimate.</small></label><label>Height (${onboardingDraft.units === "imperial" ? "inches" : "cm"})<input name="height" type="number" step=".1" value="${onboardingDraft.height}" required inputmode="decimal" /></label><label>Current weight (${onboardingDraft.units === "imperial" ? "lb" : "kg"})<input name="weight" type="number" step=".1" value="${onboardingDraft.weight}" required inputmode="decimal" /></label></div>`;
  if (onboardingStep === 2) body = `<div class="choice-stack">${Object.entries(ACTIVITY_LEVELS).map(([key, value]) => `<label class="choice-card"><input type="radio" name="activityLevel" value="${key}" ${onboardingDraft.activityLevel === key ? "checked" : ""}/><span><strong>${value.label}</strong><small>${value.detail}</small></span></label>`).join("")}</div>`;
  if (onboardingStep === 3) body = `<div class="goal-choice"><label class="choice-card"><input type="radio" name="goalType" value="lose" ${onboardingDraft.goalType === "lose" ? "checked" : ""}/><span><strong>Lose weight</strong><small>Create a reasonable calorie deficit</small></span></label><label class="choice-card"><input type="radio" name="goalType" value="maintain" ${onboardingDraft.goalType === "maintain" ? "checked" : ""}/><span><strong>Maintain weight</strong><small>Stay near estimated maintenance</small></span></label><label class="choice-card"><input type="radio" name="goalType" value="gain" ${onboardingDraft.goalType === "gain" ? "checked" : ""}/><span><strong>Gain weight</strong><small>Create a gradual calorie surplus</small></span></label></div><div class="onboarding-fields two"><label>Target weight<input name="targetWeight" type="number" step=".1" value="${onboardingDraft.targetWeight}" inputmode="decimal" /></label><label>Intensity<select name="goalIntensity">${onboardingDraft.goalType === "lose" ? `<option value="slow" ${onboardingDraft.goalIntensity === "slow" ? "selected" : ""}>Slow</option><option value="normal" ${onboardingDraft.goalIntensity === "normal" ? "selected" : ""}>Normal</option><option value="faster" ${onboardingDraft.goalIntensity === "faster" ? "selected" : ""}>Faster but reasonable</option>` : onboardingDraft.goalType === "gain" ? `<option value="slow" ${onboardingDraft.goalIntensity === "slow" ? "selected" : ""}>Slow gain</option><option value="normal" ${onboardingDraft.goalIntensity === "normal" ? "selected" : ""}>Normal gain</option>` : `<option value="normal">Maintain</option>`}</select></label></div>`;
  if (onboardingStep === 4) body = `<div class="onboarding-fields"><label>Diet preference<select name="dietPreference"><option value="mixed" ${onboardingDraft.dietPreference === "mixed" ? "selected" : ""}>Mixed</option><option value="vegetarian" ${onboardingDraft.dietPreference === "vegetarian" ? "selected" : ""}>Vegetarian</option><option value="non-vegetarian" ${onboardingDraft.dietPreference === "non-vegetarian" ? "selected" : ""}>Non-vegetarian</option><option value="eggetarian" ${onboardingDraft.dietPreference === "eggetarian" ? "selected" : ""}>Eggetarian</option><option value="custom" ${onboardingDraft.dietPreference === "custom" ? "selected" : ""}>Other / custom</option></select></label><label>Allergies<input name="allergies" value="${escapeHtml(onboardingDraft.allergies)}" placeholder="e.g. peanuts" /></label><label>Foods to avoid<input name="foodsToAvoid" value="${escapeHtml(onboardingDraft.foodsToAvoid)}" placeholder="e.g. pork" /></label><label>Disliked foods<input name="dislikedFoods" value="${escapeHtml(onboardingDraft.dislikedFoods)}" placeholder="e.g. mushrooms" /></label></div>`;
  if (onboardingStep === 5) body = `<div class="target-preview"><article><span>Estimated BMR</span><strong>${targets.bmr}<small> kcal</small></strong></article><article><span>Maintenance / TDEE</span><strong>${targets.tdee}<small> kcal</small></strong></article><label>Daily calories<input name="calorieTarget" type="number" min="1000" max="6000" value="${onboardingDraft.calorieTarget || targets.calorieTarget}" /></label><label>Protein target<input name="proteinTarget" type="number" min="20" max="400" value="${onboardingDraft.proteinTarget || targets.proteinTarget}" /><small>grams/day</small></label><label>Water target<input name="waterTargetMl" type="number" min="500" max="10000" step="100" value="${onboardingDraft.waterTargetMl || targets.waterTargetMl}" /><small>ml/day</small></label></div>${targets.safetyFloorApplied ? `<p class="safety-note">The general calorie floor was applied. These are wellness estimates, not medical advice.</p>` : `<p class="safety-note">These are general estimates. You can adjust them now or later in Settings.</p>`}`;
  if (onboardingStep === 6) body = `<div class="confirmation-summary"><div class="confirmation-icon">✓</div><h3>Your starting plan is ready</h3><p>Built from your profile using the Mifflin–St Jeor equation and your selected activity level.</p><div><span>Current weight<strong>${onboardingDraft.weight} ${onboardingDraft.units === "imperial" ? "lb" : "kg"}</strong></span><span>Goal weight<strong>${onboardingDraft.targetWeight} ${onboardingDraft.units === "imperial" ? "lb" : "kg"}</strong></span><span>Daily calories<strong>${onboardingDraft.calorieTarget || targets.calorieTarget} kcal</strong></span><span>Protein target<strong>${onboardingDraft.proteinTarget || targets.proteinTarget} g</strong></span><span>Water target<strong>${((onboardingDraft.waterTargetMl || targets.waterTargetMl) / 1000).toFixed(1)} L</strong></span></div></div>`;
  target.innerHTML = `<form id="onboardingForm"><div class="dialog-heading onboarding-heading"><div><p>STEP ${onboardingStep} OF 6</p><h2>${steps[onboardingStep - 1]}</h2></div><button type="button" data-close-onboarding aria-label="Close">×</button></div><div class="step-progress">${steps.map((step, index) => `<i class="${index + 1 <= onboardingStep ? "active" : ""}"><span>${index + 1}</span></i>`).join("")}</div><div class="onboarding-body">${body}</div><div class="dialog-actions onboarding-actions">${onboardingStep > 1 ? `<button type="button" class="secondary" data-onboarding-back>Back</button>` : `<span></span>`}<button type="submit">${onboardingStep === 6 ? "Start tracking" : "Continue"}</button></div></form>`;
}

function collectOnboarding(form) {
  const data = new FormData(form);
  for (const [key, value] of data.entries()) onboardingDraft[key] = ["age", "height", "weight", "targetWeight", "calorieTarget", "proteinTarget", "waterTargetMl"].includes(key) ? Number(value) : value;
  if (onboardingStep === 3 && onboardingDraft.goalType === "maintain") onboardingDraft.goalIntensity = "normal";
  if (onboardingStep === 5) Object.assign(onboardingDraft, calculateNutritionTargets(onboardingDraft), { calorieTarget: Number(data.get("calorieTarget")), proteinTarget: Number(data.get("proteinTarget")), waterTargetMl: Number(data.get("waterTargetMl")) });
}

function openFoodDialog(mode = "menu", mealType = null) {
  foodMode = mode;
  reviewMeal = mealType ? { mealType } : null;
  reviewSource = null;
  photoPayload = null;
  renderFoodDialog();
  const dialog = document.querySelector("#foodDialog");
  if (!dialog.open) dialog.showModal();
}

function renderFoodDialog() {
  const target = document.querySelector("#foodDialogContent");
  const close = `<button type="button" data-close-food aria-label="Close">×</button>`;
  if (foodMode === "menu") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">FAST & FLEXIBLE</p><h2>Add food</h2></div>${close}</div><div class="add-food-menu"><button type="button" data-food-mode="photo"><span>⌁</span><strong>Scan food</strong><small>Take or upload a photo</small></button><button type="button" data-food-mode="text"><span>✦</span><strong>Describe meal</strong><small>Type naturally</small></button><button type="button" data-food-mode="voice" class="voice-option"><span>◉</span><strong>Voice log</strong><small>Speak what you ate</small></button><button type="button" data-food-mode="quick"><span>＋</span><strong>Quick add</strong><small>Enter known nutrition</small></button><button type="button" data-food-mode="recent"><span>↻</span><strong>Recent</strong><small>Repeat a previous meal</small></button><button type="button" data-food-mode="favorites"><span>♡</span><strong>Favorites</strong><small>Use a saved meal</small></button></div>`;
    if (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window)) target.querySelector(".voice-option")?.setAttribute("hidden", "");
    return;
  }
  if (foodMode === "text" || foodMode === "voice") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">AI MEAL ANALYSIS</p><h2>${foodMode === "voice" ? "Speak your meal" : "Describe your meal"}</h2></div>${close}</div><form id="textMealForm" class="nutrition-form"><label>What did you eat?<textarea id="mealDescription" name="description" required placeholder="2 roti, rice, dal and chicken curry"></textarea></label>${foodMode === "voice" ? `<button type="button" class="voice-button" data-start-voice>◉ Start listening</button>` : `<div class="example-chips"><button type="button" data-meal-example="I had one banana and black coffee">Banana + coffee</button><button type="button" data-meal-example="I ate approximately 200g biryani with one boiled egg">Biryani + egg</button></div>`}<label>Meal<select name="mealType">${mealOptions(reviewMeal?.mealType)}</select></label><p class="estimate-note">AI estimates may vary with portion size and preparation. You will review everything before saving.</p><button class="primary-action full" type="submit">✦ Analyze meal</button></form>`;
    return;
  }
  if (foodMode === "photo") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">AI VISION</p><h2>Scan your meal</h2></div>${close}</div><form id="photoMealForm" class="nutrition-form"><label class="photo-drop"><input id="foodPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"/><span>⌁</span><strong>Take a photo or choose one</strong><small>Clear lighting and a top-down view work best.</small></label><div id="photoPreview"></div><label>Correction or context <input name="correction" placeholder="e.g. This is fish, not chicken" /></label><label>Meal<select name="mealType">${mealOptions(reviewMeal?.mealType)}</select></label><p class="estimate-note">Only the compressed image is sent for analysis. The original photo is not stored.</p><button class="primary-action full" type="submit">Analyze photo</button></form>`;
    return;
  }
  if (foodMode === "quick") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">NO AI NEEDED</p><h2>Quick add</h2></div>${close}</div><form id="quickMealForm" class="nutrition-form"><label>Food name<input name="name" required maxlength="80" placeholder="Coffee" /></label><div class="form-pair"><label>Calories<input name="calories" type="number" min="0" max="10000" required inputmode="numeric" /></label><label>Quantity<input name="quantity" type="number" min=".01" step=".01" value="1" inputmode="decimal" /></label></div><div class="form-triple"><label>Protein (g)<input name="protein" type="number" min="0" step=".1" value="0" inputmode="decimal" /></label><label>Carbs (g)<input name="carbs" type="number" min="0" step=".1" value="0" inputmode="decimal" /></label><label>Fat (g)<input name="fat" type="number" min="0" step=".1" value="0" inputmode="decimal" /></label></div><label>Meal<select name="mealType">${mealOptions(reviewMeal?.mealType)}</select></label><label class="inline-check"><input type="checkbox" name="treatMeal"/> Mark as a treat / high-calorie meal</label><label>Notes<textarea name="notes" maxlength="240"></textarea></label><button class="primary-action full" type="submit">Save food</button></form>`;
    return;
  }
  if (foodMode === "recent" || foodMode === "favorites") {
    const items = foodMode === "recent" ? [...nutrition.mealLogs].sort((a, b) => String(b.localUpdatedAt || b.date).localeCompare(String(a.localUpdatedAt || a.date))).slice(0, 12) : nutrition.favoriteMeals;
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">${foodMode === "recent" ? "HISTORY" : "SAVED"}</p><h2>${foodMode === "recent" ? "Recent meals" : "Favorite meals"}</h2></div>${close}</div><div class="repeat-list">${items.length ? items.map(item => { const totals = mealTotals(item.foods); return `<button type="button" data-repeat-${foodMode === "recent" ? "meal" : "favorite"}="${item.id}"><span><strong>${escapeHtml(item.name || item.mealName)}</strong><small>${totals.calories} kcal · ${totals.protein}g protein</small></span><b>Add</b></button>`; }).join("") : `<div class="nutrition-empty compact"><span>♡</span><h3>Nothing here yet</h3><p>Your saved meals will make logging much faster.</p></div>`}</div>`;
    return;
  }
  if (foodMode === "weight") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">WEIGHT TREND</p><h2>Log weight</h2></div>${close}</div><form id="weightForm" class="nutrition-form"><label>Weight (${nutrition.profile.units === "imperial" ? "lb" : "kg"})<input name="weight" type="number" min="30" max="1000" step=".1" value="${nutrition.profile.weight}" required inputmode="decimal" /></label><label>Date<input name="date" type="date" max="${localDateKey()}" value="${selectedDate <= localDateKey() ? selectedDate : localDateKey()}" required /></label><label>Note<textarea name="note" maxlength="160" placeholder="Optional context"></textarea></label><p class="estimate-note">Look at the trend over time; small daily fluctuations are normal.</p><button class="primary-action full" type="submit">Save weight</button></form>`;
    return;
  }
  if (foodMode === "water") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">HYDRATION</p><h2>Add water</h2></div>${close}</div><form id="waterForm" class="nutrition-form"><label>Amount (ml)<input name="amountMl" type="number" min="1" max="5000" step="50" value="300" required inputmode="numeric" /></label><button class="primary-action full" type="submit">Add water</button></form>`;
    return;
  }
  if (foodMode === "plan") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">MEAL PLANNER</p><h2>Plan a meal</h2></div>${close}</div><form id="planMealForm" class="nutrition-form"><label>Meal name<input name="mealName" required maxlength="100" placeholder="Soya egg fried rice" /></label><div class="form-pair"><label>Date<input name="date" type="date" min="${localDateKey()}" value="${localDateKey()}" required /></label><label>Meal<select name="mealType">${mealOptions("dinner")}</select></label></div><div class="form-triple"><label>Calories<input name="calories" type="number" min="0" value="0" inputmode="numeric" /></label><label>Protein (g)<input name="protein" type="number" min="0" step=".1" value="0" inputmode="decimal" /></label><label>Prep (min)<input name="preparationMinutes" type="number" min="0" value="20" inputmode="numeric" /></label></div><label>Notes<textarea name="notes" maxlength="240"></textarea></label><button class="primary-action full" type="submit">Save to plan</button></form>`;
    return;
  }
  if (foodMode === "suggestions") {
    target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">AI SUGGESTIONS</p><h2>What fits today</h2></div>${close}</div><div class="suggestion-results dialog-results">${(reviewMeal?.suggestions || []).map(suggestionCard).join("")}</div>`;
    return;
  }
  if (foodMode === "loading") {
    target.innerHTML = `<div class="ai-loading"><div class="ai-orbit"><i></i><i></i><i></i></div><p class="eyebrow">AI NUTRITION</p><h2>Analyzing your meal…</h2><div class="loading-steps"><span>Identifying foods</span><span>Estimating portions</span><span>Calculating nutrition</span></div><p>Keep this window open. This may take a few seconds.</p></div>`;
    return;
  }
  if (foodMode === "review") renderMealReview(target, close);
}

function mealOptions(selected = "") { return MEAL_TYPES.map(type => `<option value="${type}" ${selected === type ? "selected" : ""}>${MEAL_LABELS[type]}</option>`).join(""); }

function renderMealReview(target, close) {
  reviewMeal ||= { mealName: "Meal", mealType: "snacks", foods: [], overallConfidence: "medium", assumptions: [], warnings: [] };
  const totals = mealTotals(reviewMeal.foods);
  target.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">REVIEW ESTIMATE</p><h2>Edit before saving</h2></div>${close}</div><form id="reviewMealForm" class="review-form"><div class="review-summary"><label>Meal name<input name="mealName" value="${escapeHtml(reviewMeal.mealName || "Meal")}" required /></label><label>Meal<select name="mealType">${mealOptions(reviewMeal.mealType)}</select></label></div><div id="reviewFoods" class="review-foods">${reviewMeal.foods.map((food, index) => reviewFoodRow(food, index)).join("")}</div><button type="button" class="add-review-food" data-add-review-food>＋ Add missing food</button><div id="reviewTotals" class="review-totals"><span><strong>${totals.calories}</strong> kcal</span><span><strong>${totals.protein}</strong>g protein</span><span><strong>${totals.carbs}</strong>g carbs</span><span><strong>${totals.fat}</strong>g fat</span></div>${reviewMeal.aiEstimated || reviewSource ? `<div class="confidence-note ${escapeHtml(reviewMeal.overallConfidence || "medium")}"><strong>${capitalize(reviewMeal.overallConfidence || "medium")} confidence</strong><span>Estimated nutrition can vary with recipe and portion size.</span></div>` : ""}${reviewMeal.assumptions?.length ? `<details><summary>AI assumptions</summary><ul>${reviewMeal.assumptions.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}${reviewMeal.warnings?.length ? `<div class="review-warning">${reviewMeal.warnings.map(item => `<p>${escapeHtml(item)}</p>`).join("")}</div>` : ""}<label class="inline-check"><input type="checkbox" name="treatMeal" ${reviewMeal.treatMeal ? "checked" : ""}/> Mark as a treat / high-calorie meal</label><div class="dialog-actions"><button type="button" class="secondary" data-analyze-again>Analyze again</button><button type="submit">Save meal</button></div></form>`;
}

function reviewFoodRow(food, index) {
  const item = normalizeFood(food);
  return `<fieldset class="review-food" data-food-index="${index}"><legend>Food ${index + 1}</legend><button type="button" data-remove-review-food="${index}" aria-label="Remove food">×</button><label class="food-name">Name<input name="foodName" value="${escapeHtml(item.name)}" required /></label><label>Quantity<input name="quantity" type="number" min=".01" step=".01" value="${item.quantity}" inputmode="decimal" /></label><label>Unit<input name="unit" value="${escapeHtml(item.unit)}" /></label><label>Grams<input name="grams" type="number" min="0" value="${item.estimatedGrams}" inputmode="numeric" /></label><label>Calories<input name="calories" type="number" min="0" value="${item.calories}" inputmode="numeric" /></label><label>Protein<input name="protein" type="number" min="0" step=".1" value="${item.protein}" inputmode="decimal" /></label><label>Carbs<input name="carbs" type="number" min="0" step=".1" value="${item.carbs}" inputmode="decimal" /></label><label>Fat<input name="fat" type="number" min="0" step=".1" value="${item.fat}" inputmode="decimal" /></label></fieldset>`;
}

function collectReview(form) {
  const foods = [...form.querySelectorAll(".review-food")].map(fieldset => ({
    name: fieldset.querySelector('[name="foodName"]').value,
    quantity: fieldset.querySelector('[name="quantity"]').value,
    unit: fieldset.querySelector('[name="unit"]').value,
    estimatedGrams: fieldset.querySelector('[name="grams"]').value,
    calories: fieldset.querySelector('[name="calories"]').value,
    protein: fieldset.querySelector('[name="protein"]').value,
    carbs: fieldset.querySelector('[name="carbs"]').value,
    fat: fieldset.querySelector('[name="fat"]').value,
    confidence: reviewMeal.foods[fieldset.dataset.foodIndex]?.confidence || "medium"
  })).map(normalizeFood);
  reviewMeal = { ...reviewMeal, mealName: form.mealName.value.trim(), mealType: form.mealType.value, treatMeal: form.treatMeal.checked, foods, totals: mealTotals(foods) };
  return reviewMeal;
}

async function saveReviewedMeal(form) {
  const meal = collectReview(form);
  if (!meal.foods.length) return showToast("Add at least one food before saving.", "error");
  await repository.save("mealLogs", { ...meal, id: meal.id || id("meal"), date: meal.date || selectedDate, time: meal.time || new Date().toTimeString().slice(0, 5), inputMethod: meal.inputMethod || reviewSource || "manual", aiEstimated: Boolean(reviewSource || meal.aiEstimated), aiProvider: reviewSource ? aiStatus.provider : meal.aiProvider || "", createdAtLocal: meal.createdAtLocal || new Date().toISOString() });
  document.querySelector("#foodDialog").close();
  showToast(reviewMeal.id ? "Meal updated." : "Meal saved.");
  reviewMeal = null;
  renderNutrition();
}

function aiContext(mealType = "") {
  const totals = currentTotals();
  const profile = nutrition.profile;
  return { mealType, localDate: selectedDate, remainingCalories: Math.max(0, profile.calorieTarget - totals.calories), remainingProtein: Math.max(0, profile.proteinTarget - totals.protein), dietPreference: profile.dietPreference, allergies: profile.allergies, foodsToAvoid: profile.foodsToAvoid };
}

async function analyzeText(form) {
  const data = new FormData(form);
  foodMode = "loading"; renderFoodDialog();
  try {
    reviewSource = "ai-text";
    reviewMeal = { ...(await aiNutritionService.analyzeTextMeal(data.get("description"), aiContext(data.get("mealType")))), mealType: data.get("mealType"), aiEstimated: true };
    foodMode = "review"; renderFoodDialog();
  } catch (error) { foodMode = "text"; renderFoodDialog(); showToast(error.message, "error"); }
}

async function analyzePhoto(form) {
  if (!photoPayload) return showToast("Choose a food photo first.", "error");
  const data = new FormData(form);
  foodMode = "loading"; renderFoodDialog();
  try {
    reviewSource = "ai-photo";
    reviewMeal = { ...(await aiNutritionService.analyzeFoodImage(photoPayload.base64, photoPayload.mimeType, data.get("correction"), aiContext(data.get("mealType")))), mealType: data.get("mealType"), aiEstimated: true };
    foodMode = "review"; renderFoodDialog();
  } catch (error) { foodMode = "photo"; renderFoodDialog(); showToast(error.message, "error"); }
}

async function saveQuickMeal(form) {
  const data = new FormData(form);
  const food = normalizeFood({ name: data.get("name"), quantity: data.get("quantity"), unit: "serving", calories: data.get("calories"), protein: data.get("protein"), carbs: data.get("carbs"), fat: data.get("fat"), confidence: "high" });
  await repository.save("mealLogs", { id: id("meal"), date: selectedDate, time: new Date().toTimeString().slice(0, 5), mealName: food.name, mealType: data.get("mealType"), foods: [food], notes: String(data.get("notes") || "").slice(0, 240), treatMeal: data.get("treatMeal") === "on", inputMethod: "quick", aiEstimated: false, createdAtLocal: new Date().toISOString() });
  document.querySelector("#foodDialog").close(); showToast("Food added."); renderNutrition();
}

async function addMealCopy(item, date = selectedDate) {
  await repository.save("mealLogs", { ...item, id: id("meal"), date, time: new Date().toTimeString().slice(0, 5), inputMethod: "repeat", createdAtLocal: new Date().toISOString() });
  const dialog = document.querySelector("#foodDialog");
  if (dialog.open) dialog.close();
  showToast("Meal added again."); renderNutrition();
}

function capitalize(value) { return String(value).charAt(0).toUpperCase() + String(value).slice(1); }

function suggestionCard(suggestion, index = 0) {
  return `<article class="recipe-card"><div class="recipe-top"><span>${suggestion.preparationMinutes || 20} min · ${escapeHtml(suggestion.difficulty || "Easy")}</span><strong>${Math.round(suggestion.calories)} kcal</strong></div><h3>${escapeHtml(suggestion.mealName)}</h3><p>${escapeHtml(suggestion.description)}</p><div class="recipe-macros"><span>${suggestion.protein}g protein</span><span>${suggestion.carbs}g carbs</span><span>${suggestion.fat}g fat</span></div><details><summary>Ingredients & steps</summary><p>${(suggestion.ingredients || []).map(escapeHtml).join(" · ")}</p><ol>${(suggestion.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol></details><p class="why-fit">${escapeHtml(suggestion.whyItFits)}</p><div class="recipe-actions"><button type="button" data-cook-suggestion="${index}">Add today</button><button type="button" data-plan-suggestion="${index}">Plan it</button><button type="button" data-favorite-suggestion="${index}">♡ Save</button></div></article>`;
}

root.addEventListener("click", async event => {
  const target = event.target;
  if (target.closest("[data-go-habits]")) return setModule("habits");
  if (target.closest("[data-start-onboarding]")) { onboardingStep = 1; onboardingDraft = defaultProfileDraft(); renderOnboarding(); return document.querySelector("#nutritionOnboarding").showModal(); }
  const dateShift = target.closest("[data-shift-date]");
  if (dateShift) { selectedDate = shiftDateKey(selectedDate, Number(dateShift.dataset.shiftDate)); return renderNutrition(); }
  if (target.closest("[data-open-food]")) return openFoodDialog();
  const addToMeal = target.closest("[data-add-to-meal]");
  if (addToMeal) return openFoodDialog("menu", addToMeal.dataset.addToMeal);
  const mode = target.closest("[data-food-mode]");
  if (mode) return openFoodDialog(mode.dataset.foodMode);
  const water = target.closest("[data-add-water]");
  if (water) { await repository.save("waterLogs", { id: id("water"), date: selectedDate, amountMl: Number(water.dataset.addWater), createdAtLocal: new Date().toISOString() }); showToast(`${water.dataset.addWater} ml added.`); return renderNutrition(); }
  if (target.closest("[data-custom-water]")) return openFoodDialog("water");
  if (target.closest("[data-undo-water]")) {
    const latest = waterForDate().sort((a, b) => String(b.createdAtLocal).localeCompare(String(a.createdAtLocal)))[0];
    if (latest) await repository.remove("waterLogs", latest.id);
    showToast("Last water entry removed.", "info"); return renderNutrition();
  }
  if (target.closest("[data-log-weight]")) return openFoodDialog("weight");
  if (target.closest("[data-save-note]")) {
    const text = document.querySelector("#dailyNote").value.trim();
    if (text) await repository.save("dailyNotes", { id: selectedDate, date: selectedDate, text }); else await repository.remove("dailyNotes", selectedDate);
    return showToast("Daily note saved.");
  }
  const editMeal = target.closest("[data-edit-meal]");
  if (editMeal) {
    reviewMeal = JSON.parse(JSON.stringify(nutrition.mealLogs.find(meal => meal.id === editMeal.dataset.editMeal)));
    reviewSource = null; foodMode = "review"; renderFoodDialog(); return document.querySelector("#foodDialog").showModal();
  }
  const deleteMeal = target.closest("[data-delete-meal]");
  if (deleteMeal && confirm("Delete this meal from your nutrition history?")) { await repository.remove("mealLogs", deleteMeal.dataset.deleteMeal); showToast("Meal deleted.", "info"); return renderNutrition(); }
  const favoriteMeal = target.closest("[data-favorite-meal]");
  if (favoriteMeal) {
    const meal = nutrition.mealLogs.find(item => item.id === favoriteMeal.dataset.favoriteMeal);
    await repository.save("favoriteMeals", { id: id("favorite"), name: meal.mealName, mealName: meal.mealName, mealType: meal.mealType, foods: meal.foods, createdAtLocal: new Date().toISOString() });
    return showToast("Saved to favorites.");
  }
  if (target.closest("[data-what-eat]")) {
    openFoodDialog("loading");
    try { reviewMeal = await aiNutritionService.generateMealSuggestions({ ...aiContext(), previousMeals: mealsForDate().map(meal => meal.mealName), request: "What should I eat next?" }); foodMode = "suggestions"; renderFoodDialog(); }
    catch (error) { document.querySelector("#foodDialog").close(); showToast(error.message, "error"); }
    return;
  }
  const range = target.closest("[data-progress-days]");
  if (range) { progressDays = Number(range.dataset.progressDays); return renderNutrition(); }
  if (target.closest("[data-create-plan]")) return openFoodDialog("plan");
  const eatPlan = target.closest("[data-eat-plan]");
  if (eatPlan) {
    const plan = nutrition.mealPlans.find(item => item.id === eatPlan.dataset.eatPlan);
    if (plan) { await repository.save("mealLogs", { id: id("meal"), date: plan.date, time: new Date().toTimeString().slice(0, 5), mealName: plan.mealName, mealType: plan.mealType, foods: plan.foods?.length ? plan.foods : [normalizeFood({ name: plan.mealName, calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat, quantity: 1, unit: "serving", confidence: "high" })], inputMethod: "meal-plan", aiEstimated: Boolean(plan.aiEstimated), createdAtLocal: new Date().toISOString() }); await repository.remove("mealPlans", plan.id); showToast("Planned meal moved to your log."); renderNutrition(); }
    return;
  }
  const deletePlan = target.closest("[data-delete-plan]");
  if (deletePlan && confirm("Remove this meal from your plan?")) { await repository.remove("mealPlans", deletePlan.dataset.deletePlan); return renderNutrition(); }
  const addFavorite = target.closest("[data-add-favorite]");
  if (addFavorite) { const favorite = nutrition.favoriteMeals.find(item => item.id === addFavorite.dataset.addFavorite); if (favorite) await addMealCopy({ ...favorite, mealName: favorite.name || favorite.mealName }); return; }
  const deleteFavorite = target.closest("[data-delete-favorite]");
  if (deleteFavorite && confirm("Delete this favorite meal?")) { await repository.remove("favoriteMeals", deleteFavorite.dataset.deleteFavorite); showToast("Favorite removed.", "info"); return renderNutrition(); }
  if (target.closest("[data-recalculate-targets]")) {
    const form = document.querySelector("#nutritionSettingsForm");
    const values = Object.fromEntries(new FormData(form));
    const calculated = calculateNutritionTargets({ ...nutrition.profile, ...values });
    form.calorieTarget.value = calculated.calorieTarget; form.proteinTarget.value = calculated.proteinTarget; form.waterTargetMl.value = calculated.waterTargetMl;
    return showToast("Recommended targets recalculated. Save when ready.", "info");
  }
  if (target.closest("[data-test-ai]")) {
    target.closest("button").disabled = true;
    try { await aiNutritionService.request("testAIConnection"); showToast("AI connection is working."); }
    catch (error) { showToast(error.message, "error"); }
    finally { target.closest("button").disabled = false; }
  }
});

root.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "cookForm") {
    const data = new FormData(event.target), results = document.querySelector("#cookResults");
    results.innerHTML = `<div class="inline-loading">Generating practical ideas…</div>`;
    try {
      reviewMeal = await aiNutritionService.generateRecipeSuggestions({ ...aiContext(data.get("mealType")), ingredients: data.get("ingredients"), preparationMinutes: Number(data.get("minutes")), mealType: data.get("mealType") });
      results.innerHTML = reviewMeal.suggestions.map(suggestionCard).join("");
    } catch (error) { results.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`; }
  }
  if (event.target.id === "nutritionSettingsForm") {
    const values = Object.fromEntries(new FormData(event.target));
    const numeric = ["age", "height", "weight", "targetWeight", "calorieTarget", "proteinTarget", "waterTargetMl"];
    numeric.forEach(key => values[key] = Number(values[key]));
    const recommended = calculateNutritionTargets({ ...nutrition.profile, ...values });
    await repository.saveProfile({ ...nutrition.profile, ...values, carbsTarget: recommended.carbsTarget, fatTarget: recommended.fatTarget, updatedAtLocal: new Date().toISOString() });
    showToast("Nutrition settings saved."); renderNutrition();
  }
});

document.querySelector("#mobileAddFood").addEventListener("click", () => openFoodDialog());

document.addEventListener("click", async event => {
  const target = event.target;
  if (target.closest("[data-close-food]")) return document.querySelector("#foodDialog").close();
  if (target.closest("[data-close-onboarding]")) return document.querySelector("#nutritionOnboarding").close();
  if (target.closest("[data-onboarding-back]")) { onboardingStep -= 1; return renderOnboarding(); }
  const mode = target.closest("[data-food-mode]");
  if (mode && target.closest("#foodDialog")) { foodMode = mode.dataset.foodMode; return renderFoodDialog(); }
  const example = target.closest("[data-meal-example]");
  if (example) { document.querySelector("#mealDescription").value = example.dataset.mealExample; return; }
  if (target.closest("[data-add-review-food]")) { collectReview(document.querySelector("#reviewMealForm")); reviewMeal.foods.push(normalizeFood({ name: "New food", quantity: 1, unit: "serving" })); return renderFoodDialog(); }
  const removeFood = target.closest("[data-remove-review-food]");
  if (removeFood) { collectReview(document.querySelector("#reviewMealForm")); reviewMeal.foods.splice(Number(removeFood.dataset.removeReviewFood), 1); return renderFoodDialog(); }
  if (target.closest("[data-analyze-again]")) { foodMode = reviewSource === "ai-photo" ? "photo" : "text"; reviewMeal = null; return renderFoodDialog(); }
  const repeatMeal = target.closest("[data-repeat-meal]");
  if (repeatMeal) return addMealCopy(nutrition.mealLogs.find(item => item.id === repeatMeal.dataset.repeatMeal));
  const repeatFavorite = target.closest("[data-repeat-favorite]");
  if (repeatFavorite) { const favorite = nutrition.favoriteMeals.find(item => item.id === repeatFavorite.dataset.repeatFavorite); return addMealCopy({ ...favorite, mealName: favorite.name || favorite.mealName }); }
  if (target.closest("[data-start-voice]")) return startVoiceRecognition();
  const suggestionAction = target.closest("[data-cook-suggestion], [data-plan-suggestion], [data-favorite-suggestion]");
  if (suggestionAction) {
    const index = Number(suggestionAction.dataset.cookSuggestion ?? suggestionAction.dataset.planSuggestion ?? suggestionAction.dataset.favoriteSuggestion);
    const suggestion = reviewMeal?.suggestions?.[index];
    if (!suggestion) return;
    if (suggestionAction.hasAttribute("data-cook-suggestion")) { await addMealCopy(suggestionToMeal(suggestion)); return; }
    if (suggestionAction.hasAttribute("data-plan-suggestion")) { await repository.save("mealPlans", { ...suggestionToMeal(suggestion), id: id("plan"), date: shiftDateKey(localDateKey(), 1), preparationMinutes: suggestion.preparationMinutes }); showToast("Added to tomorrow's meal plan."); return renderNutrition(); }
    await repository.save("favoriteMeals", { ...suggestionToMeal(suggestion), id: id("favorite"), name: suggestion.mealName }); return showToast("Saved to favorites.");
  }
});

document.addEventListener("change", async event => {
  if (event.target.id !== "foodPhoto" || !event.target.files[0]) return;
  const preview = document.querySelector("#photoPreview");
  preview.innerHTML = `<div class="inline-loading">Preparing photo…</div>`;
  try { photoPayload = await compressFoodPhoto(event.target.files[0]); preview.innerHTML = `<img src="${photoPayload.dataUrl}" alt="Selected meal preview"/><span>${Math.round(photoPayload.size / 1024)} KB compressed</span>`; }
  catch (error) { photoPayload = null; preview.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`; }
});

document.addEventListener("input", event => {
  const form = event.target.closest("#reviewMealForm");
  if (!form) return;
  const meal = collectReview(form), totals = mealTotals(meal.foods);
  document.querySelector("#reviewTotals").innerHTML = `<span><strong>${totals.calories}</strong> kcal</span><span><strong>${totals.protein}</strong>g protein</span><span><strong>${totals.carbs}</strong>g carbs</span><span><strong>${totals.fat}</strong>g fat</span>`;
});

document.addEventListener("submit", async event => {
  if (!event.target.closest("#foodDialog, #nutritionOnboarding")) return;
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "onboardingForm") {
      collectOnboarding(form);
      if (onboardingStep < 6) { onboardingStep += 1; return renderOnboarding(); }
      const targets = calculateNutritionTargets(onboardingDraft);
      const profile = { ...onboardingDraft, ...targets, calorieTarget: onboardingDraft.calorieTarget || targets.calorieTarget, proteinTarget: onboardingDraft.proteinTarget || targets.proteinTarget, waterTargetMl: onboardingDraft.waterTargetMl || targets.waterTargetMl, createdAtLocal: new Date().toISOString() };
      await repository.saveProfile(profile);
      await repository.save("weightLogs", { id: id("weight"), date: localDateKey(), weightKg: weightToKg(profile.weight, profile.units), note: "Starting weight", createdAtLocal: new Date().toISOString() });
      document.querySelector("#nutritionOnboarding").close(); showToast("Your Calories Tracker is ready."); return renderNutrition();
    }
    if (form.id === "textMealForm") return analyzeText(form);
    if (form.id === "photoMealForm") return analyzePhoto(form);
    if (form.id === "quickMealForm") return saveQuickMeal(form);
    if (form.id === "reviewMealForm") return saveReviewedMeal(form);
    if (form.id === "weightForm") {
      const data = new FormData(form), weight = Number(data.get("weight"));
      await repository.save("weightLogs", { id: id("weight"), date: data.get("date"), weightKg: weightToKg(weight, nutrition.profile.units), note: String(data.get("note") || "").slice(0, 160), createdAtLocal: new Date().toISOString() });
      await repository.saveProfile({ ...nutrition.profile, weight, updatedAtLocal: new Date().toISOString() });
      document.querySelector("#foodDialog").close(); showToast("Weight logged."); return renderNutrition();
    }
    if (form.id === "waterForm") {
      const amountMl = clampNumber(new FormData(form).get("amountMl"), 1, 5000);
      await repository.save("waterLogs", { id: id("water"), date: selectedDate, amountMl, createdAtLocal: new Date().toISOString() });
      document.querySelector("#foodDialog").close(); showToast(`${amountMl} ml added.`); return renderNutrition();
    }
    if (form.id === "planMealForm") {
      const data = new FormData(form);
      await repository.save("mealPlans", { id: id("plan"), mealName: data.get("mealName"), date: data.get("date"), mealType: data.get("mealType"), calories: Number(data.get("calories")), protein: Number(data.get("protein")), preparationMinutes: Number(data.get("preparationMinutes")), notes: String(data.get("notes") || "").slice(0, 240), createdAtLocal: new Date().toISOString() });
      document.querySelector("#foodDialog").close(); showToast("Meal planned."); return renderNutrition();
    }
  } catch (error) { showToast(error.message || "That could not be saved. Please try again.", "error"); }
});

function suggestionToMeal(suggestion) {
  return { mealName: suggestion.mealName, mealType: "dinner", foods: [normalizeFood({ name: suggestion.mealName, quantity: 1, unit: "serving", calories: suggestion.calories, protein: suggestion.protein, carbs: suggestion.carbs, fat: suggestion.fat, confidence: "medium" })], aiEstimated: true, overallConfidence: "medium", inputMethod: "ai-suggestion" };
}

function startVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return showToast("Voice logging is not supported in this browser.", "error");
  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-IN";
  recognition.interimResults = false;
  const button = document.querySelector("[data-start-voice]");
  button.textContent = "Listening…"; button.disabled = true;
  recognition.onresult = event => { document.querySelector("#mealDescription").value = event.results[0][0].transcript; button.textContent = "✓ Meal captured"; };
  recognition.onerror = () => { showToast("Microphone input was not available. You can type instead.", "error"); button.textContent = "◉ Start listening"; button.disabled = false; };
  recognition.onend = () => { button.disabled = false; };
  recognition.start();
}
