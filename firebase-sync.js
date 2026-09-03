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
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc
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

let currentUser = null;
let userDocument = null;
let unsubscribeDocument = null;
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

function showSignedOut() {
  const shouldClearPrivateCopy = Boolean(localStorage.getItem(OWNER_KEY));
  currentUser = null;
  userDocument = null;
  unsubscribeDocument?.();
  unsubscribeDocument = null;
  document.body.classList.remove("auth-pending");
  authGate.hidden = false;
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
continueOffline.addEventListener("click", () => {
  authGate.hidden = true;
  document.body.classList.remove("auth-pending");
});
signOutButton.addEventListener("click", () => signOut(auth));

getRedirectResult(auth).catch(error => {
  console.error("Google redirect sign-in failed", error);
  showMessage("Google sign-in could not finish. Please try again.", true);
});

onAuthStateChanged(auth, user => {
  if (!user) { showSignedOut(); return; }
  connectUser(user).catch(error => {
    console.error("Could not connect account", error);
    showSignedIn(user);
    setSyncStatus("Saved locally", "offline");
  });
});
