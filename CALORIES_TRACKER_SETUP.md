# Calories Tracker architecture and setup

## What was added

The existing Habit Tracker remains unchanged as its own module. The same signed-in, approved Firebase account now opens separate Calories, Meal Planner, Progress, and Nutrition Settings views.

Nutrition data is stored under the existing user:

```text
users/{uid}/nutritionProfile/current
users/{uid}/mealLogs/{mealId}
users/{uid}/waterLogs/{waterId}
users/{uid}/weightLogs/{weightId}
users/{uid}/favoriteMeals/{favoriteId}
users/{uid}/mealPlans/{planId}
users/{uid}/dailyNotes/{yyyy-mm-dd}
```

The browser keeps an offline cache and queues ordinary meals, water, weight, plans, favorites, and profile changes. AI features require an internet connection.

## AI architecture

```text
Calories UI
  -> AINutritionService (provider-neutral browser client)
  -> authenticated Google Apps Script endpoint
  -> AIProvider contract
  -> GeminiProvider (active implementation)
  -> normalized meal/suggestion schema
```

The UI and Firestore never use a Gemini-specific response. `GeminiProvider` converts structured Gemini output into the shared nutrition schema, validates values, clamps impossible numbers, and recalculates totals from individual foods.

To add OpenAI later, create `OpenAIProvider` in the Apps Script implementing `analyzeTextMeal`, `analyzeFoodImage`, `generateMealSuggestions`, and `generateRecipeSuggestions`. Select it in `getAIProvider`. No Calories UI, meal schema, analytics, planner, onboarding, or Firestore changes should be required.

## One-time Gemini setup

1. Open [Google AI Studio API keys](https://aistudio.google.com/app/apikey).
2. Create an API key in a Google project you control. Do not paste it into the website or commit it to GitHub.
3. Open the existing Apps Script project used by the tracker.
4. In **Project Settings → Script Properties**, add:

```text
AI_PROVIDER = gemini
GEMINI_API_KEY = your_key_from_google_ai_studio
GEMINI_MODEL = gemini-3.5-flash-lite
```

`gemini-3.5-flash-lite` is a stable, free-tier-capable multimodal model. The model is configurable, so it can be upgraded without changing the app.

5. Replace the Apps Script source with `access-request-notifier.gs` from this repository.
6. Choose **Deploy → Manage deployments → Edit**, select **New version**, keep **Execute as: Me** and **Who has access: Anyone**, then deploy.
7. Do not change the deployment URL. The website already points to the existing endpoint.

The endpoint verifies the Firebase sign-in token, permits only the owner or approved members, and limits each account to 30 AI requests per hour. The Gemini key stays in Script Properties and is never returned to the browser.

Never place the key in a local `.env` file for this static frontend. Common `.env`, service-account, and Firebase debug files are ignored by Git as a defense-in-depth safeguard, but the only supported key location is **Apps Script → Project Settings → Script Properties**.

## Confirm the AI connection

1. Open the deployed tracker and sign in.
2. Open **Settings** from the app navigation.
3. Under **AI Nutrition**, confirm that the provider is Gemini and the status is Connected.
4. Select **Test AI connection**.
5. Open Calories → Add Food → Describe Meal and analyze `two rotis with chicken curry`.
6. Confirm that an editable review screen appears before saving.
7. Test Food Photo with a clear JPG/PNG/WebP image.

If the key, provider, model, quota, image, session, or network is invalid, the app shows a plain-language error while Quick Add and other non-AI features continue working.

## Local development

This remains a dependency-free static PWA. Serve the repository through a local HTTP server rather than opening `index.html` directly. Firebase Authentication must allow the local hostname. AI calls still use the deployed Apps Script endpoint.

Example:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Firebase deployment

From an authenticated environment with Firebase CLI installed:

```bash
firebase deploy --only firestore:rules --project habit-tracker-sync-c7fc8
firebase deploy --only hosting --project habit-tracker-sync-c7fc8
```

The updated rules retain the existing owner/approval model and extend it to the signed-in user's nutrition subcollections. They never allow public health-data access.

## API usage and limitations

- AI calls happen only for text/photo analysis and meal/recipe suggestions.
- Totals, BMR, TDEE, targets, analytics, water, weight, history, and repeated meals use deterministic code and no AI tokens.
- Images are resized to at most 1280 px and compressed before analysis. Originals are not stored.
- Photo nutrition is approximate because portions, hidden oil, and recipes are difficult to infer visually. Every estimate is editable before saving.
- Free-tier model availability and request limits are controlled by Google and may change. Check the current [Gemini pricing page](https://ai.google.dev/gemini-api/docs/pricing).
- The tracker provides general wellness estimates, not medical advice.
