interface OnboardingState {
  quickStartShown: boolean;
  quickStartCompleted: boolean;
}

const STORAGE_KEY = 'fluxtty.onboarding.v1';

function defaultState(): OnboardingState {
  return {
    quickStartShown: false,
    quickStartCompleted: false,
  };
}

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      quickStartShown: !!parsed.quickStartShown,
      quickStartCompleted: !!parsed.quickStartCompleted,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures in private mode / restricted environments.
  }
}

export function getOnboardingState(): OnboardingState {
  return loadState();
}

export function shouldAutoShowQuickStart(restoredWorkspace: boolean): boolean {
  if (restoredWorkspace) return false;
  return !getOnboardingState().quickStartShown;
}

export function hasCompletedQuickStart(): boolean {
  return getOnboardingState().quickStartCompleted;
}

export function markQuickStartShown() {
  const state = loadState();
  if (state.quickStartShown) return;
  state.quickStartShown = true;
  saveState(state);
}

export function markQuickStartCompleted() {
  const state = loadState();
  state.quickStartShown = true;
  state.quickStartCompleted = true;
  saveState(state);
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures in private mode / restricted environments.
  }
}
