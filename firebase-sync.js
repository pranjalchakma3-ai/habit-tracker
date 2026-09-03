import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithRedirect,
  signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  doc,
  collection,
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYbXTprIV6Wkvnua50bGltWCtOOE1XfXc",
  authDomain: "habit-tracker-sync-c7fc8.firebaseapp.com",
  projectId: "habit-tracker-sync-c7fc8",
  storageBucket: "habit-tracker-sync-c7fc8.firebasestorage.app",
  messagingSenderId: "3269559983",
  appId: "1:3269559983:web:7bfb71b96a26105facb65a"
};

const STORAGE_KEY = "simple-habit-tracker-v1";
const OWNER_KEY = `${STORAGE_KEY}-owner`;
const OWNER_EMAIL = "pranjalchakma3@gmail.com";
const ACCESS_REQUEST_EMAIL_URL = "https://script.google.com/macros/s/AKfycbzLVkFelq7r-ZEZx3d0KG6Uh5ZDY-8H73XdXvLDRy71WaSI4VrEhN3drHCgdZAjOv6q/exec";

function importGitHubTrackerState() {
  try {
    const transfer = JSON.parse(window.name || "null");
    const transferredState = transfer?.source === "habit-tracker-github" ? JSON.parse(transfer.state) : null;
    if (transferredState && Array.isArray(transferredState.habits)) {
      localStorage.setItem(STORAGE_KEY, transfer.state);
      window.name = "";
    }
  } catch {
    // A malformed or unrelated window name is ignored.
  }
}

importGitHubTrackerState();
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const authGate = document.querySelector("#authGate");
const authMessage = document.querySelector("#authMessage");
const googleSignIn = document.querySelector("#googleSignIn");
const continueOffline = document.querySelector("#continueOffline");
const cloudAccount = document.querySelector("#cloudAccount");
const userAvatar = document.querySelector("#userAvatar");
const userName = document.querySelector("#userName");
const syncStatus = document.querySelector("#syncStatus");
const signOutButton = document.querySelector("#signOut");
const storageNote = document.querySelector("#checkinStorageNote");
const signInContent = document.querySelector("#signInContent");
const accessRequestContent = document.querySelector("#accessRequestContent");
const accessRequestTitle = document.querySelector("#accessRequestTitle");
const accessRequestMessage = document.querySelector("#accessRequestMessage");
const requestAccessButton = document.querySelector("#requestAccess");
const accessSignOutButton = document.querySelector("#accessSignOut");
const accessAdmin = document.querySelector("#accessAdmin");
const accessRequestCount = document.querySelector("#accessRequestCount");
const accessRequestList = document.querySelector("#accessRequestList");

let currentUser = null;
let userDocument = null;
let unsubscribeDocument = null;
let unsubscribeRequests = null;
let saveSequence = Promise.resolve();
let pendingStateJson = null;

function readLocalState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}

function showMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle("is-error", isError);
}

function setSyncStatus(message, mode = "") {
  syncStatus.textContent = message;
  syncStatus.dataset.mode = mode;
}

function isOwner(user) {
  return user?.email?.toLowerCase() === OWNER_EMAIL;
}

function escapeHtml(value = "") {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function stopOwnerRequests() {
  unsubscribeRequests?.();
  unsubscribeRequests = null;
  accessAdmin.hidden = true;
}

function showSignedOut() {
  const shouldClearPrivateCopy = Boolean(localStorage.getItem(OWNER_KEY));
  currentUser = null;
  userDocument = null;
  unsubscribeDocument?.();
  unsubscribeDocument = null;
  stopOwnerRequests();
  document.body.classList.remove("auth-pending");
  authGate.hidden = false;
  signInContent.hidden = false;
  accessRequestContent.hidden = true;
  cloudAccount.hidden = true;
  storageNote.textContent = "Choose a score for today. Your latest check-in is saved locally.";
  googleSignIn.disabled = false;
  googleSignIn.classList.remove("is-loading");
  if (shouldClearPrivateCopy) {
    localStorage.removeItem(OWNER_KEY);
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("habit-cloud-state", { detail: { reset: true } }));
  }
}

function showSignedIn(user) {
  document.body.classList.remove("auth-pending");
  authGate.hidden = true;
  cloudAccount.hidden = false;
  userName.textContent = user.displayName || "Google account";
  userAvatar.src = user.photoURL || "habit-tracker-icon.svg";
  userAvatar.alt = user.displayName ? `${user.displayName}'s profile photo` : "Profile photo";
  storageNote.textContent = "Choose a score for today. Changes sync automatically across your devices.";
}

function showAccessRequest(status, user) {
  document.body.classList.add("auth-pending");
  authGate.hidden = false;
  signInContent.hidden = true;
  accessRequestContent.hidden = false;
  cloudAccount.hidden = true;
  const name = user.displayName || user.email || "this Google account";
  if (status === "pending") {
    accessRequestTitle.textContent = "Request sent";
    accessRequestMessage.textContent = `Your access request for ${name} is waiting for the owner’s approval. You will be able to use the tracker after approval.`;
    requestAccessButton.hidden = true;
  } else if (status === "denied" || status === "revoked") {
    accessRequestTitle.textContent = "Access not approved";
    accessRequestMessage.textContent = "This Google account is not approved for this private Habit Tracker. Use another account or contact the owner.";
    requestAccessButton.hidden = true;
  } else {
    accessRequestTitle.textContent = "Request access";
    accessRequestMessage.textContent = `This Habit Tracker is private. Send a request for ${name} and the owner will receive it by Gmail.`;
    requestAccessButton.hidden = false;
    requestAccessButton.disabled = false;
  }
}

function broadcastState(nextState) {
  window.dispatchEvent(new CustomEvent("habit-cloud-state", { detail: { state: nextState } }));
}

function stateJson(nextState) {
  if (Array.isArray(nextState)) return `[${nextState.map(stateJson).join(",")}]`;
  if (nextState && typeof nextState === "object") {
    return `{${Object.keys(nextState).sort().map(key => `${JSON.stringify(key)}:${stateJson(nextState[key])}`).join(",")}}`;
  }
  return JSON.stringify(nextState);
}

function applyCloudState(nextState) {
  const incomingStateJson = stateJson(nextState);
  // A listener can receive an older snapshot while a new local action is
  // being uploaded. Keep the latest action visible until its matching cloud
  // snapshot arrives.
  if (pendingStateJson && incomingStateJson !== pendingStateJson) return false;
  if (pendingStateJson === incomingStateJson) pendingStateJson = null;
  broadcastState(nextState);
  return true;
}

async function connectUser(user) {
  currentUser = user;
  userDocument = doc(db, "users", user.uid);
  showSignedIn(user);
  setSyncStatus("Connecting…", "busy");

  const snapshot = await getDoc(userDocument);
  if (snapshot.exists() && snapshot.data()?.state) {
    localStorage.setItem(OWNER_KEY, user.uid);
    applyCloudState(snapshot.data().state);
  } else {
    const localState = readLocalState() || window.getHabitTrackerState?.();
    if (localState) {
      await setDoc(userDocument, { state: localState, version: 1, updatedAt: serverTimestamp() });
      localStorage.setItem(OWNER_KEY, user.uid);
      broadcastState(localState);
    }
  }

  unsubscribeDocument?.();
  unsubscribeDocument = onSnapshot(userDocument, snapshotUpdate => {
    if (snapshotUpdate.exists() && snapshotUpdate.data()?.state) applyCloudState(snapshotUpdate.data().state);
    setSyncStatus(snapshotUpdate.metadata.fromCache ? "Offline copy" : "Synced", snapshotUpdate.metadata.fromCache ? "offline" : "ready");
  }, error => {
    console.error("Habit sync failed", error);
    setSyncStatus("Saved locally", "offline");
  });
}

function renderOwnerRequests(snapshot) {
  const requests = snapshot.docs
    .map(entry => ({ id: entry.id, ...entry.data() }))
    .filter(request => request.status === "pending")
    .sort((first, second) => (second.requestedAt?.toMillis?.() || 0) - (first.requestedAt?.toMillis?.() || 0));
  accessRequestCount.textContent = String(requests.length);
  accessRequestList.innerHTML = requests.length ? requests.map(request => `<article class="access-request-item"><strong>${escapeHtml(request.displayName || "Google user")}</strong><small>${escapeHtml(request.email || request.id)}</small><div class="access-request-actions"><button type="button" data-approve-access="${escapeHtml(request.id)}">Approve</button><button type="button" class="deny" data-deny-access="${escapeHtml(request.id)}">Deny</button></div></article>`).join("") : "<p class='access-request-empty'>No pending requests. Gmail alerts will appear here too.</p>";
}

function startOwnerRequests() {
  if (!currentUser || !isOwner(currentUser)) return;
  accessAdmin.hidden = false;
  unsubscribeRequests?.();
  unsubscribeRequests = onSnapshot(collection(db, "accessRequests"), renderOwnerRequests, error => {
    console.error("Could not load access requests", error);
    accessRequestList.innerHTML = "<p class='access-request-empty'>Requests could not be loaded right now.</p>";
  });
}

async function checkAccess(user) {
  currentUser = user;
  if (isOwner(user)) {
    await connectUser(user);
    startOwnerRequests();
    return;
  }
  stopOwnerRequests();
  const membership = await getDoc(doc(db, "members", user.uid));
  if (membership.exists() && membership.data()?.status === "approved") {
    await connectUser(user);
    return;
  }
  const request = await getDoc(doc(db, "accessRequests", user.uid));
  showAccessRequest(request.exists() ? request.data()?.status : "new", user);
}

async function sendAccessRequest() {
  if (!currentUser) return;
  requestAccessButton.disabled = true;
  requestAccessButton.textContent = "Sending request…";
  try {
    await setDoc(doc(db, "accessRequests", currentUser.uid), {
      uid: currentUser.uid,
      email: currentUser.email || "",
      displayName: currentUser.displayName || "Google user",
      status: "pending",
      requestedAt: serverTimestamp()
    });
    if (ACCESS_REQUEST_EMAIL_URL) {
      const idToken = await currentUser.getIdToken();
      await fetch(ACCESS_REQUEST_EMAIL_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ idToken })
      });
    }
    showAccessRequest("pending", currentUser);
  } catch (error) {
    console.error("Access request failed", error);
    requestAccessButton.disabled = false;
    requestAccessButton.textContent = "Send access request";
    accessRequestMessage.textContent = "The request could not be sent. Please try again.";
  }
}

async function decideAccess(userId, status) {
  if (!currentUser || !isOwner(currentUser)) return;
  const requestReference = doc(db, "accessRequests", userId);
  const request = await getDoc(requestReference);
  if (!request.exists()) return;
  const details = request.data();
  const actionButton = document.querySelector(`[data-${status === "approved" ? "approve" : "deny"}-access="${CSS.escape(userId)}"]`);
  if (actionButton) actionButton.disabled = true;
  try {
    await setDoc(doc(db, "members", userId), { uid: userId, email: details.email || "", displayName: details.displayName || "Google user", status, decidedAt: serverTimestamp(), decidedBy: currentUser.uid });
    await updateDoc(requestReference, { status, decidedAt: serverTimestamp(), decidedBy: currentUser.uid });
  } catch (error) {
    console.error("Access decision failed", error);
    if (actionButton) actionButton.disabled = false;
  }
}

async function beginGoogleSignIn() {
  googleSignIn.disabled = true;
  googleSignIn.classList.add("is-loading");
  showMessage("Opening Google sign-in…");
  try {
    await signInWithRedirect(auth, provider);
  } catch (error) {
    console.error("Google sign-in failed", error);
    showMessage("Google sign-in could not open. Please check your connection and try again.", true);
    googleSignIn.disabled = false;
    googleSignIn.classList.remove("is-loading");
  }
}

window.habitCloud = {
  save(nextState) {
    if (!currentUser || !userDocument) return Promise.resolve();
    pendingStateJson = stateJson(nextState);
    setSyncStatus("Syncing…", "busy");
    saveSequence = saveSequence
      .catch(() => undefined)
      // Replace the complete tracker snapshot so removed checks stay removed.
      // A merge would keep deleted keys inside state.entries in Firestore.
      .then(() => setDoc(userDocument, { state: nextState, version: 1, updatedAt: serverTimestamp() }))
      .then(() => setSyncStatus("Synced", "ready"))
      .catch(error => {
        console.error("Habit save failed", error);
        setSyncStatus("Saved locally", "offline");
      });
    return saveSequence;
  }
};

googleSignIn.addEventListener("click", beginGoogleSignIn);
requestAccessButton.addEventListener("click", sendAccessRequest);
accessSignOutButton.addEventListener("click", () => signOut(auth));
continueOffline.addEventListener("click", () => {
  authGate.hidden = true;
  document.body.classList.remove("auth-pending");
});
signOutButton.addEventListener("click", () => signOut(auth));
accessRequestList.addEventListener("click", event => {
  const approve = event.target.closest("[data-approve-access]");
  const deny = event.target.closest("[data-deny-access]");
  if (approve) decideAccess(approve.dataset.approveAccess, "approved");
  if (deny) decideAccess(deny.dataset.denyAccess, "denied");
});

getRedirectResult(auth).catch(error => {
  console.error("Google redirect sign-in failed", error);
  showMessage("Google sign-in could not finish. Please try again.", true);
});

onAuthStateChanged(auth, user => {
  if (!user) { showSignedOut(); return; }
  checkAccess(user).catch(error => {
    console.error("Could not verify account access", error);
    showAccessRequest("new", user);
    accessRequestMessage.textContent = "Access could not be verified. Please check your connection and try again.";
  });
});
