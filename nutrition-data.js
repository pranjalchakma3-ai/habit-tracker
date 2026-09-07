import { db } from "./firebase-sync.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const COLLECTIONS = ["mealLogs", "waterLogs", "weightLogs", "favoriteMeals", "mealPlans", "dailyNotes"];
const CACHE_PREFIX = "health-tracker-nutrition-v1";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function makeId(prefix = "item") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

export class NutritionRepository extends EventTarget {
  constructor(userId) {
    super();
    this.userId = userId;
    this.key = `${CACHE_PREFIX}:${userId}`;
    this.cache = this.readCache();
    this.online = navigator.onLine;
    this.handleOnline = () => { this.online = true; this.sync().catch(() => undefined); };
    this.handleOffline = () => { this.online = false; this.emit(); };
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  readCache() {
    try {
      const value = JSON.parse(localStorage.getItem(this.key));
      return { profile: null, mealLogs: [], waterLogs: [], weightLogs: [], favoriteMeals: [], mealPlans: [], dailyNotes: [], deletions: [], ...value };
    } catch {
      return { profile: null, mealLogs: [], waterLogs: [], weightLogs: [], favoriteMeals: [], mealPlans: [], dailyNotes: [], deletions: [] };
    }
  }

  persist() {
    localStorage.setItem(this.key, JSON.stringify(this.cache));
    this.emit();
  }

  emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: { state: this.snapshot(), online: this.online } }));
  }

  snapshot() { return copy(this.cache); }

  async sync() {
    if (!navigator.onLine) { this.online = false; this.emit(); return this.snapshot(); }
    this.online = true;
    try {
      await this.flushPending();
      const profileSnapshot = await getDoc(doc(db, "users", this.userId, "nutritionProfile", "current"));
      if (profileSnapshot.exists()) this.cache.profile = { ...profileSnapshot.data(), _sync: "synced" };
      await Promise.all(COLLECTIONS.map(async name => {
        const results = await getDocs(query(collection(db, "users", this.userId, name), limit(400)));
        const pending = new Map(this.cache[name].filter(item => item._sync === "pending").map(item => [item.id, item]));
        const remote = results.docs.map(entry => ({ id: entry.id, ...entry.data(), _sync: "synced" }));
        remote.forEach(item => pending.delete(item.id));
        this.cache[name] = [...remote, ...pending.values()];
      }));
      this.persist();
      return this.snapshot();
    } catch (error) {
      this.online = false;
      this.emit();
      throw error;
    }
  }

  async flushPending() {
    for (const deletion of [...this.cache.deletions]) {
      await deleteDoc(doc(db, "users", this.userId, deletion.collection, deletion.id));
      this.cache.deletions = this.cache.deletions.filter(item => !(item.collection === deletion.collection && item.id === deletion.id));
    }
    if (this.cache.profile?._sync === "pending") await this.writeProfile(this.cache.profile);
    for (const name of COLLECTIONS) {
      for (const item of this.cache[name].filter(entry => entry._sync === "pending")) await this.writeItem(name, item);
    }
  }

  async writeProfile(profile) {
    const payload = copy(profile);
    delete payload._sync;
    await setDoc(doc(db, "users", this.userId, "nutritionProfile", "current"), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
    this.cache.profile._sync = "synced";
    this.persist();
  }

  async saveProfile(profile) {
    this.cache.profile = { ...copy(profile), _sync: "pending", localUpdatedAt: new Date().toISOString() };
    this.persist();
    if (navigator.onLine) await this.writeProfile(this.cache.profile).catch(() => { this.online = false; this.emit(); });
    return copy(this.cache.profile);
  }

  async writeItem(name, item) {
    const payload = copy(item);
    delete payload._sync;
    await setDoc(doc(db, "users", this.userId, name, item.id), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
    const saved = this.cache[name].find(entry => entry.id === item.id);
    if (saved) saved._sync = "synced";
    this.persist();
  }

  async save(name, value) {
    if (!COLLECTIONS.includes(name)) throw new Error("Unknown nutrition collection.");
    const item = { ...copy(value), id: value.id || makeId(name), _sync: "pending", localUpdatedAt: new Date().toISOString() };
    const index = this.cache[name].findIndex(entry => entry.id === item.id);
    if (index >= 0) this.cache[name][index] = item; else this.cache[name].push(item);
    this.persist();
    if (navigator.onLine) await this.writeItem(name, item).catch(() => { this.online = false; this.emit(); });
    return copy(item);
  }

  async remove(name, id) {
    if (!COLLECTIONS.includes(name)) throw new Error("Unknown nutrition collection.");
    this.cache[name] = this.cache[name].filter(item => item.id !== id);
    this.cache.deletions.push({ collection: name, id });
    this.persist();
    if (navigator.onLine) {
      await deleteDoc(doc(db, "users", this.userId, name, id)).then(() => {
        this.cache.deletions = this.cache.deletions.filter(item => !(item.collection === name && item.id === id));
        this.persist();
      }).catch(() => { this.online = false; this.emit(); });
    }
  }

  destroy() {
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }
}
