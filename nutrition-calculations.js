export const ACTIVITY_LEVELS = {
  sedentary: { label: "Sedentary", detail: "Little structured exercise", multiplier: 1.2 },
  light: { label: "Lightly active", detail: "Light exercise about 1–3 days/week", multiplier: 1.375 },
  moderate: { label: "Moderately active", detail: "Moderate exercise about 3–5 days/week", multiplier: 1.55 },
  very: { label: "Very active", detail: "Hard exercise about 6–7 days/week", multiplier: 1.725 }
};

const GOAL_ADJUSTMENTS = {
  lose: { slow: -250, normal: -400, faster: -500 },
  maintain: { normal: 0 },
  gain: { slow: 200, normal: 350 }
};

export function clampNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

export function localDateKey(date = new Date()) {
  const local = new Date(date);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

export function dateFromKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function shiftDateKey(key, offset) {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + offset);
  return localDateKey(date);
}

export function calculateNutritionTargets(profile) {
  const weightKg = profile.units === "imperial" ? clampNumber(profile.weight, 1) * 0.453592 : clampNumber(profile.weight, 1);
  const heightCm = profile.units === "imperial" ? clampNumber(profile.height, 1) * 2.54 : clampNumber(profile.height, 1);
  const age = clampNumber(profile.age, 13, 100);
  const sexOffset = profile.formulaSex === "male" ? 5 : -161;
  const bmr = Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset);
  const activity = ACTIVITY_LEVELS[profile.activityLevel] || ACTIVITY_LEVELS.sedentary;
  const tdee = Math.round(bmr * activity.multiplier);
  const goalType = profile.goalType || "maintain";
  const intensity = profile.goalIntensity || "normal";
  const adjustment = GOAL_ADJUSTMENTS[goalType]?.[intensity] ?? 0;
  const calculatedCalories = Math.round((tdee + adjustment) / 10) * 10;
  const generalFloor = profile.formulaSex === "male" ? 1500 : 1200;
  const calorieTarget = Math.max(generalFloor, calculatedCalories);
  const proteinMultiplier = goalType === "maintain" ? 1.4 : 1.6;
  const proteinTarget = Math.max(50, Math.round(weightKg * proteinMultiplier));
  const waterTargetMl = Math.max(1500, Math.round(weightKg * 35 / 100) * 100);
  return {
    bmr,
    tdee,
    calorieTarget,
    proteinTarget,
    carbsTarget: Math.max(80, Math.round((calorieTarget * 0.45) / 4)),
    fatTarget: Math.max(35, Math.round((calorieTarget * 0.28) / 9)),
    waterTargetMl,
    safetyFloorApplied: calorieTarget !== calculatedCalories,
    calculatedCalories
  };
}

export function normalizeFood(food = {}) {
  return {
    id: food.id || `food-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    name: String(food.name || "Food").trim().slice(0, 80),
    quantity: clampNumber(food.quantity || 1, 0.01, 10000),
    unit: String(food.unit || "serving").trim().slice(0, 24),
    estimatedGrams: Math.round(clampNumber(food.estimatedGrams, 0, 10000)),
    calories: Math.round(clampNumber(food.calories, 0, 10000)),
    protein: Math.round(clampNumber(food.protein, 0, 1000) * 10) / 10,
    carbs: Math.round(clampNumber(food.carbs, 0, 1000) * 10) / 10,
    fat: Math.round(clampNumber(food.fat, 0, 1000) * 10) / 10,
    confidence: ["high", "medium", "low"].includes(food.confidence) ? food.confidence : "medium"
  };
}

export function mealTotals(foods = []) {
  return foods.map(normalizeFood).reduce((total, food) => ({
    calories: total.calories + food.calories,
    protein: Math.round((total.protein + food.protein) * 10) / 10,
    carbs: Math.round((total.carbs + food.carbs) * 10) / 10,
    fat: Math.round((total.fat + food.fat) * 10) / 10
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

export function dayTotals(meals = [], waterLogs = []) {
  const foodTotals = meals.reduce((total, meal) => {
    const mealTotal = mealTotals(meal.foods || []);
    return {
      calories: total.calories + mealTotal.calories,
      protein: Math.round((total.protein + mealTotal.protein) * 10) / 10,
      carbs: Math.round((total.carbs + mealTotal.carbs) * 10) / 10,
      fat: Math.round((total.fat + mealTotal.fat) * 10) / 10
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return { ...foodTotals, waterMl: waterLogs.reduce((sum, log) => sum + clampNumber(log.amountMl, 0, 10000), 0) };
}

export function targetPercent(value, target) {
  return target > 0 ? Math.max(0, Math.round((value / target) * 100)) : 0;
}

export function weightToKg(weight, units) {
  return units === "imperial" ? clampNumber(weight) * 0.453592 : clampNumber(weight);
}

export function displayWeight(weightKg, units) {
  return units === "imperial" ? `${(weightKg / 0.453592).toFixed(1)} lb` : `${weightKg.toFixed(1)} kg`;
}

export function buildDailySeries(meals, waterLogs, profile, days = 7, endKey = localDateKey()) {
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDateKey(endKey, index - days + 1);
    const totals = dayTotals(meals.filter(meal => meal.date === date), waterLogs.filter(log => log.date === date));
    return { date, ...totals, calorieTarget: profile?.calorieTarget || 0, proteinTarget: profile?.proteinTarget || 0, waterTargetMl: profile?.waterTargetMl || 0 };
  });
}
