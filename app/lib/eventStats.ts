/**
 * In-process event counter for Torque analytics.
 * Survives within a single server process; resets on cold start.
 * Good enough for hackathon demos — replace with Redis/DB for production.
 */

export interface EventStats {
  sessions: number;       // physioloop_session_completed
  caregiverCheckins: number; // physioloop_caregiver_checkin
  plansStarted: number;   // physioloop_plan_started
  plansCompleted: number; // physioloop_plan_completed
  physiosRegistered: number; // physioloop_physio_registered
  lastUpdated: string;    // ISO timestamp
}

const stats: EventStats = {
  sessions: 0,
  caregiverCheckins: 0,
  plansStarted: 0,
  plansCompleted: 0,
  physiosRegistered: 0,
  lastUpdated: new Date().toISOString(),
};

export function incrementStat(event: string): void {
  switch (event) {
    case "physioloop_session_completed":   stats.sessions++;          break;
    case "physioloop_caregiver_checkin":   stats.caregiverCheckins++; break;
    case "physioloop_plan_started":        stats.plansStarted++;      break;
    case "physioloop_plan_completed":      stats.plansCompleted++;    break;
    case "physioloop_physio_registered":   stats.physiosRegistered++; break;
  }
  stats.lastUpdated = new Date().toISOString();
}

export function getStats(): EventStats {
  return { ...stats };
}
