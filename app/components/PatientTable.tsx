"use client";

import { FC, useState } from "react";
import { completionPct, pusdToDisplay, shortenAddress } from "@/lib/anchor";

export interface PatientRow {
  planAddress: string;
  patientAddress: string;
  patientName: string;
  condition: string;
  sessionsCompleted: number;
  sessionsTotal: number;
  pusdPerSession: number;
  planActive: boolean;
  createdAt: number;
}

interface PatientTableProps {
  patients: PatientRow[];
  loading?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="ml-1 text-gray-300 hover:text-gray-500 transition-colors"
      title="Copy plan address"
    >
      {copied ? (
        <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

export const PatientTable: FC<PatientTableProps> = ({ patients, loading }) => {
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 p-8 text-center text-gray-400">
        Loading patients…
      </div>
    );
  }

  if (patients.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-gray-400">
        <p className="text-lg font-medium">No treatment plans yet</p>
        <p className="text-sm mt-1">Create a plan to add your first patient.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wide">
          <tr>
            <th className="px-4 py-3 text-left">Patient</th>
            <th className="px-4 py-3 text-left">Condition</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">Compliance</th>
            <th className="px-4 py-3 text-left">Sessions</th>
            <th className="px-4 py-3 text-left">Earnings</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {patients.map((p) => {
            const pct = completionPct(p.sessionsCompleted, p.sessionsTotal);
            // Physio earns 70% of the session fee
            const earned = Math.round(p.sessionsCompleted * p.pusdPerSession * 0.7);
            return (
              <tr key={p.planAddress} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900 text-sm">
                    {p.patientName || shortenAddress(p.patientAddress)}
                  </p>
                  <div className="flex items-center mt-0.5">
                    <span className="font-mono text-[10px] text-gray-400">
                      {shortenAddress(p.planAddress, 5)}
                    </span>
                    <CopyButton text={p.planAddress} />
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-800 font-medium max-w-[160px] truncate" title={p.condition}>
                  {p.condition || <span className="text-gray-400 italic">—</span>}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.planActive
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {p.planActive ? "Active" : "Pending"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-24 rounded-full bg-gray-200 h-1.5 overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-gray-600 tabular-nums">{pct}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums text-gray-600">
                  {p.sessionsCompleted}/{p.sessionsTotal}
                </td>
                <td className="px-4 py-3 font-medium text-green-700">
                  ${pusdToDisplay(earned)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
