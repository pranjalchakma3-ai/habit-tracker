const AI_NUTRITION_ENDPOINT = "https://script.google.com/macros/s/AKfycbzLVkFelq7r-ZEZx3d0KG6Uh5ZDY-8H73XdXvLDRy71WaSI4VrEhN3drHCgdZAjOv6q/exec";

const FRIENDLY_ERRORS = {
  NOT_CONFIGURED: "AI nutrition is not configured yet. Quick Add and your other trackers still work.",
  UNAUTHORIZED: "This account is not approved to use AI nutrition.",
  RATE_LIMITED: "AI analysis is temporarily unavailable because the usage limit has been reached.",
  BAD_MODEL: "The configured AI model is unavailable. Please check the Nutrition settings.",
  BAD_IMAGE: "This image could not be analyzed. Try a clear JPG, PNG, or WebP photo.",
  MALFORMED_RESPONSE: "The AI returned an incomplete estimate. Please try analyzing again.",
  NETWORK: "AI analysis requires an internet connection."
};

export class NutritionAIError extends Error {
  constructor(code, message) {
    super(message || FRIENDLY_ERRORS[code] || "AI analysis is temporarily unavailable.");
    this.name = "NutritionAIError";
    this.code = code;
  }
}

export class AINutritionService {
  constructor(endpoint = AI_NUTRITION_ENDPOINT) { this.endpoint = endpoint; }

  async request(action, payload = {}) {
    if (!navigator.onLine) throw new NutritionAIError("NETWORK");
    const idToken = await window.healthAuth?.getIdToken?.().catch(() => null);
    if (!idToken) throw new NutritionAIError("UNAUTHORIZED", "Sign in with an approved account to use AI nutrition.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, idToken, payload }),
        signal: controller.signal
      });
      if (!response.ok) throw new NutritionAIError("NETWORK");
      const result = await response.json();
      if (!result.ok) throw new NutritionAIError(result.code || "UNKNOWN", result.message);
      return result.data;
    } catch (error) {
      if (error instanceof NutritionAIError) throw error;
      throw new NutritionAIError("NETWORK", error.name === "AbortError" ? "AI analysis took too long. Please try again." : undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  status() { return this.request("aiStatus"); }
  analyzeTextMeal(description, context = {}) { return this.request("analyzeTextMeal", { description, context }); }
  analyzeFoodImage(image, mimeType, correction = "", context = {}) { return this.request("analyzeFoodImage", { image, mimeType, correction, context }); }
  generateMealSuggestions(input) { return this.request("generateMealSuggestions", input); }
  generateRecipeSuggestions(input) { return this.request("generateRecipeSuggestions", input); }
}

export const aiNutritionService = new AINutritionService();

export async function compressFoodPhoto(file, maxDimension = 1280, quality = 0.82) {
  if (!file?.type?.startsWith("image/")) throw new NutritionAIError("BAD_IMAGE");
  if (file.size > 20 * 1024 * 1024) throw new NutritionAIError("BAD_IMAGE", "That photo is too large. Choose an image under 20 MB.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new NutritionAIError("BAD_IMAGE");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { dataUrl, base64: String(dataUrl).split(",")[1], mimeType: "image/jpeg", size: blob.size };
}
