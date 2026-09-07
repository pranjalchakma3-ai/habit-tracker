const FIREBASE_API_KEY = "AIzaSyCYbXTprIV6Wkvnua50bGltWCtOOE1XfXc";
const FIREBASE_PROJECT_ID = "habit-tracker-sync-c7fc8";
const OWNER_EMAIL = "pranjalchakma3@gmail.com";
const APP_URL = "https://habit-tracker-sync-c7fc8.firebaseapp.com/";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

const NUTRITION_SCHEMA = {
  type: "OBJECT",
  properties: {
    mealName: { type: "STRING" },
    mealType: { type: "STRING", enum: ["breakfast", "lunch", "snacks", "dinner"] },
    foods: { type: "ARRAY", minItems: 1, maxItems: 20, items: { type: "OBJECT", properties: {
      name: { type: "STRING" }, quantity: { type: "NUMBER" }, unit: { type: "STRING" }, estimatedGrams: { type: "NUMBER" },
      calories: { type: "NUMBER" }, protein: { type: "NUMBER" }, carbs: { type: "NUMBER" }, fat: { type: "NUMBER" },
      confidence: { type: "STRING", enum: ["high", "medium", "low"] }
    }, required: ["name", "quantity", "unit", "estimatedGrams", "calories", "protein", "carbs", "fat", "confidence"] } },
    overallConfidence: { type: "STRING", enum: ["high", "medium", "low"] },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
    warnings: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["mealName", "mealType", "foods", "overallConfidence", "assumptions", "warnings"]
};

const SUGGESTIONS_SCHEMA = {
  type: "OBJECT",
  properties: { suggestions: { type: "ARRAY", minItems: 3, maxItems: 5, items: { type: "OBJECT", properties: {
    mealName: { type: "STRING" }, description: { type: "STRING" }, ingredients: { type: "ARRAY", items: { type: "STRING" } },
    calories: { type: "NUMBER" }, protein: { type: "NUMBER" }, carbs: { type: "NUMBER" }, fat: { type: "NUMBER" },
    preparationMinutes: { type: "NUMBER" }, difficulty: { type: "STRING" }, steps: { type: "ARRAY", items: { type: "STRING" } }, whyItFits: { type: "STRING" }
  }, required: ["mealName", "description", "ingredients", "calories", "protein", "carbs", "fat", "preparationMinutes", "difficulty", "steps", "whyItFits"] } } },
  required: ["suggestions"]
};

class AIProvider {
  analyzeTextMeal() { throw new Error("Provider must implement analyzeTextMeal"); }
  analyzeFoodImage() { throw new Error("Provider must implement analyzeFoodImage"); }
  generateMealSuggestions() { throw new Error("Provider must implement generateMealSuggestions"); }
  generateRecipeSuggestions() { throw new Error("Provider must implement generateRecipeSuggestions"); }
}

class GeminiProvider extends AIProvider {
  constructor(apiKey, model) { super(); this.apiKey = apiKey; this.model = model || DEFAULT_GEMINI_MODEL; }
  analyzeTextMeal(payload) {
    return normalizeMeal(this.generate([{ text: `${baseNutritionPrompt()}\nUser description: ${cleanText(payload.description, 1200)}\nContext: ${JSON.stringify(payload.context || {})}` }], NUTRITION_SCHEMA));
  }
  analyzeFoodImage(payload) {
    if (!payload.image || !/^image\/(jpeg|png|webp)$/.test(payload.mimeType || "")) throw apiError("BAD_IMAGE", "Use a JPG, PNG, or WebP image.");
    const correction = payload.correction ? `User correction: ${cleanText(payload.correction, 400)}` : "";
    return normalizeMeal(this.generate([{ inlineData: { mimeType: payload.mimeType, data: payload.image } }, { text: `${baseNutritionPrompt()}\nAnalyze the attached meal photo. Separate visible foods from assumptions. ${correction}\nContext: ${JSON.stringify(payload.context || {})}` }], NUTRITION_SCHEMA));
  }
  generateMealSuggestions(payload) { return normalizeSuggestions(this.generate([{ text: suggestionPrompt(payload, false) }], SUGGESTIONS_SCHEMA)); }
  generateRecipeSuggestions(payload) { return normalizeSuggestions(this.generate([{ text: suggestionPrompt(payload, true) }], SUGGESTIONS_SCHEMA)); }
  generate(parts, schema) {
    const response = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "post", contentType: "application/json", headers: { "x-goog-api-key": this.apiKey },
      payload: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema } }),
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status === 429) throw apiError("RATE_LIMITED", "AI analysis is temporarily unavailable because the API limit has been reached.");
    if (status === 400 || status === 404) throw apiError("BAD_MODEL", "The configured Gemini model is unavailable.");
    if (status === 401 || status === 403) throw apiError("NOT_CONFIGURED", "The Gemini API key is missing or invalid.");
    if (status < 200 || status >= 300) throw apiError("PROVIDER_ERROR", "Gemini is temporarily unavailable.");
    const result = JSON.parse(response.getContentText());
    const output = result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts && result.candidates[0].content.parts[0] && result.candidates[0].content.parts[0].text;
    if (!output) throw apiError("MALFORMED_RESPONSE", "The AI returned an incomplete estimate.");
    try { return JSON.parse(output); } catch (error) { throw apiError("MALFORMED_RESPONSE", "The AI response could not be validated."); }
  }
}

function doPost(event) {
  try {
    const body = JSON.parse(event.postData && event.postData.contents || "{}");
    const person = verifyFirebaseUser(body.idToken);
    if (!person) return json({ ok: false, code: "UNAUTHORIZED", message: "Invalid sign-in token." });
    const action = body.action || "accessRequest";
    if (action === "accessRequest") return sendAccessEmail(person);
    if (!isAuthorized(person, body.idToken)) return json({ ok: false, code: "UNAUTHORIZED", message: "This account is not approved for AI nutrition." });

    const configuration = getAIConfiguration();
    if (action === "aiStatus") return json({ ok: true, data: { provider: configuration.provider || "Not configured", model: configuration.model || "Not configured", configured: configuration.configured } });
    enforceRateLimit(person.localId);
    if (!configuration.configured) throw apiError("NOT_CONFIGURED", "AI nutrition is not configured yet.");
    const provider = getAIProvider(configuration);
    const payload = body.payload || {};
    const handlers = {
      analyzeTextMeal: () => provider.analyzeTextMeal(payload),
      analyzeFoodImage: () => provider.analyzeFoodImage(payload),
      generateMealSuggestions: () => provider.generateMealSuggestions(payload),
      generateRecipeSuggestions: () => provider.generateRecipeSuggestions(payload),
      testAIConnection: () => ({ connected: true, sample: provider.analyzeTextMeal({ description: "one medium banana", context: {} }) })
    };
    if (!handlers[action]) throw apiError("BAD_REQUEST", "Unknown AI action.");
    return json({ ok: true, data: handlers[action]() });
  } catch (error) {
    console.error(error);
    return json({ ok: false, code: error.code || "UNKNOWN", message: error.publicMessage || "AI nutrition is temporarily unavailable." });
  }
}

function getAIConfiguration() {
  const properties = PropertiesService.getScriptProperties();
  const provider = String(properties.getProperty("AI_PROVIDER") || "").toLowerCase();
  const model = properties.getProperty("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL;
  const apiKey = properties.getProperty("GEMINI_API_KEY") || "";
  return { provider, model, apiKey, configured: provider === "gemini" && Boolean(apiKey) };
}

function getAIProvider(configuration) {
  if (configuration.provider === "gemini") return new GeminiProvider(configuration.apiKey, configuration.model);
  throw apiError("NOT_CONFIGURED", `Unsupported AI provider: ${configuration.provider || "none"}`);
}

function baseNutritionPrompt() {
  return "You are a careful nutrition estimation engine. Return only data matching the schema. Estimate realistically; never claim laboratory precision. Recognize Indian foods well, including roti, dal, curries, paneer, soya, biryani, khichdi, poha, dosa, idli, paratha, chole, rajma, samosa, momos and Maggi. Account for preparation method and hidden oil only as an explicit assumption. Do not invent invisible ingredients with high confidence. Use integers for calories and practical household portions. If identity or portion is ambiguous, use low confidence and explain it in assumptions or warnings. Choose the most likely meal type.";
}

function suggestionPrompt(payload, includeRecipes) {
  return `Suggest 3 to 5 practical ${includeRecipes ? "recipes" : "meals"} using this context: ${JSON.stringify(payload || {})}. Prefer simple home cooking and Indian foods when suitable. Respect allergies and foods to avoid. Fit remaining calories and protein where practical. Return only the required structured data. Do not present medical advice. Keep cooking steps concise.`;
}

function normalizeMeal(value) {
  if (!value || !Array.isArray(value.foods) || !value.foods.length) throw apiError("MALFORMED_RESPONSE", "No reliable foods were identified.");
  const foods = value.foods.slice(0, 20).map(food => ({
    name: cleanText(food.name || "Food", 80), quantity: clamp(food.quantity, .01, 10000), unit: cleanText(food.unit || "serving", 24),
    estimatedGrams: Math.round(clamp(food.estimatedGrams, 0, 10000)), calories: Math.round(clamp(food.calories, 0, 10000)),
    protein: round1(clamp(food.protein, 0, 1000)), carbs: round1(clamp(food.carbs, 0, 1000)), fat: round1(clamp(food.fat, 0, 1000)),
    confidence: ["high", "medium", "low"].indexOf(food.confidence) >= 0 ? food.confidence : "medium"
  }));
  const totals = foods.reduce((sum, food) => ({ calories: sum.calories + food.calories, protein: round1(sum.protein + food.protein), carbs: round1(sum.carbs + food.carbs), fat: round1(sum.fat + food.fat) }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return { mealName: cleanText(value.mealName || foods.map(food => food.name).join(" + "), 100), mealType: ["breakfast", "lunch", "snacks", "dinner"].indexOf(value.mealType) >= 0 ? value.mealType : "snacks", foods, totals, overallConfidence: ["high", "medium", "low"].indexOf(value.overallConfidence) >= 0 ? value.overallConfidence : "medium", assumptions: stringList(value.assumptions), warnings: stringList(value.warnings) };
}

function normalizeSuggestions(value) {
  if (!value || !Array.isArray(value.suggestions)) throw apiError("MALFORMED_RESPONSE", "No suggestions were returned.");
  return { suggestions: value.suggestions.slice(0, 5).map(item => ({
    mealName: cleanText(item.mealName, 100), description: cleanText(item.description, 240), ingredients: stringList(item.ingredients, 20),
    calories: Math.round(clamp(item.calories, 0, 10000)), protein: round1(clamp(item.protein, 0, 1000)), carbs: round1(clamp(item.carbs, 0, 1000)), fat: round1(clamp(item.fat, 0, 1000)),
    preparationMinutes: Math.round(clamp(item.preparationMinutes, 1, 600)), difficulty: cleanText(item.difficulty || "Easy", 30), steps: stringList(item.steps, 12), whyItFits: cleanText(item.whyItFits, 260)
  })) };
}

function isAuthorized(person, idToken) {
  if (String(person.email || "").toLowerCase() === OWNER_EMAIL) return true;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/members/${encodeURIComponent(person.localId)}`;
  const response = UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${idToken}` }, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return false;
  const member = JSON.parse(response.getContentText());
  return member.fields && member.fields.status && member.fields.status.stringValue === "approved";
}

function enforceRateLimit(uid) {
  const properties = PropertiesService.getScriptProperties();
  const hour = Utilities.formatDate(new Date(), "UTC", "yyyyMMddHH");
  const key = `ai:${uid}:${hour}`;
  const count = Number(properties.getProperty(key) || 0);
  if (count >= 30) throw apiError("RATE_LIMITED", "You have reached the temporary AI request limit. Try again later.");
  properties.setProperty(key, String(count + 1));
}

function sendAccessEmail(person) {
  const properties = PropertiesService.getScriptProperties();
  const throttleKey = `request:${person.localId}`;
  const lastSentAt = Number(properties.getProperty(throttleKey) || 0);
  if (Date.now() - lastSentAt < 5 * 60 * 1000) return json({ ok: true, duplicate: true });
  const name = person.displayName || "Google user";
  const email = person.email || "No email shared";
  MailApp.sendEmail({ to: OWNER_EMAIL, subject: `Habit Tracker access request from ${name}`, body: `${name} (${email}) requested access to your private Habit Tracker.\n\nReview it securely: ${APP_URL}`, htmlBody: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) requested access to your private Habit Tracker.</p><p><a href="${APP_URL}">Review this request securely</a></p>` });
  properties.setProperty(throttleKey, String(Date.now()));
  return json({ ok: true });
}

function apiError(code, publicMessage) { const error = new Error(publicMessage); error.code = code; error.publicMessage = publicMessage; return error; }
function clamp(value, min, max) { const number = Number(value); return isFinite(number) ? Math.min(max, Math.max(min, number)) : min; }
function round1(value) { return Math.round(value * 10) / 10; }
function cleanText(value, max) { return String(value || "").trim().slice(0, max); }
function stringList(value, max) { return (Array.isArray(value) ? value : []).slice(0, max || 10).map(item => cleanText(item, 300)).filter(Boolean); }

function verifyFirebaseUser(idToken) {
  if (!idToken) return null;
  const response = UrlFetchApp.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) return null;
  const account = JSON.parse(response.getContentText());
  return account.users && account.users[0] || null;
}

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
