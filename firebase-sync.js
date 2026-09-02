import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
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

async function connectUser(user) {
  currentUser = user;
  userDocument = doc(db, "users", user.uid);
  showSignedIn(user);
  setSyncStatus("Connecting…", "busy");

  const snapshot = await getDoc(userDocument);
  if (snapshot.exists() && snapshot.data()?.state) {
    localStorage.setItem(OWNER_KEY, user.uid);
    broadcastState(snapshot.data().state);
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
    if (snapshotUpdate.exists() && snapshotUpdate.data()?.state) broadcastState(snapshotUpdate.data().state);
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
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
      console.error("Google sign-in failed", error);
      showMessage("Google sign-in is not ready yet. You can continue offline and try again later.", true);
    }
    googleSignIn.disabled = false;
    googleSignIn.classList.remove("is-loading");
  }
}

window.habitCloud = {
  save(nextState) {
    if (!currentUser || !userDocument) return Promise.resolve();
    setSyncStatus("Syncing…", "busy");
    saveSequence = saveSequence
      .catch(() => undefined)
      .then(() => setDoc(userDocument, { state: nextState, version: 1, updatedAt: serverTimestamp() }, { merge: true }))
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
