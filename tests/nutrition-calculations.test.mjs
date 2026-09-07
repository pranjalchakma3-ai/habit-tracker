import assert from "node:assert/strict";
import { calculateNutritionTargets, mealTotals, shiftDateKey } from "../nutrition-calculations.js";

const targets = calculateNutritionTargets({ age: 30, formulaSex: "male", height: 175, weight: 75, units: "metric", activityLevel: "moderate", goalType: "lose", goalIntensity: "normal" });
assert.equal(targets.bmr, 1699);
assert.equal(targets.calorieTarget, 2230);
assert.equal(targets.proteinTarget, 120);

assert.deepEqual(mealTotals([
  { name: "Dal", calories: 180, protein: 9, carbs: 28, fat: 4 },
  { name: "Rice", calories: 240, protein: 5, carbs: 52, fat: 1 }
]), { calories: 420, protein: 14, carbs: 80, fat: 5 });

assert.equal(shiftDateKey("2026-01-31", 1), "2026-02-01");
console.log("nutrition calculation tests passed");
