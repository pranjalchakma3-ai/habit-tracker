const FIREBASE_API_KEY = "AIzaSyCYbXTprIV6Wkvnua50bGltWCtOOE1XfXc";
const OWNER_EMAIL = "pranjalchakma3@gmail.com";
const APP_URL = "https://habit-tracker-sync-c7fc8.firebaseapp.com/";

function doPost(event) {
  try {
    const body = JSON.parse(event.postData && event.postData.contents || "{}");
    const person = verifyFirebaseUser(body.idToken);
    if (!person) return json({ ok: false, error: "Invalid sign-in token." });

    const properties = PropertiesService.getScriptProperties();
    const throttleKey = `request:${person.localId}`;
    const lastSentAt = Number(properties.getProperty(throttleKey) || 0);
    if (Date.now() - lastSentAt < 5 * 60 * 1000) return json({ ok: true, duplicate: true });

    const name = person.displayName || "Google user";
    const email = person.email || "No email shared";
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: `Habit Tracker access request from ${name}`,
      body: `${name} (${email}) requested access to your private Habit Tracker.\n\nReview the request securely in your app: ${APP_URL}`,
      htmlBody: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) requested access to your private Habit Tracker.</p><p><a href="${APP_URL}">Review this request securely in Habit Tracker</a></p>`
    });
    properties.setProperty(throttleKey, String(Date.now()));
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "Could not send the access notification." });
  }
}

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
