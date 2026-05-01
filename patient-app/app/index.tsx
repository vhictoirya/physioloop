/**
 * Home screen — wallet setup + active treatment plan overview.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native'
import { router } from 'expo-router'
import { PublicKey } from '@solana/web3.js'
import { getOrCreateKeypair, makeWalletAdapter } from '../lib/wallet'
import { fetchTreatmentPlan } from '../lib/solana'
import { qvacBridge } from '../lib/bare-bridge'
import { PUSD_DECIMALS } from '../lib/constants'
import type { Keypair } from '@solana/web3.js'

interface PlanState {
  sessionsTotal: number
  sessionsCompleted: number
  pusdPerSession: number
  planActive: boolean
  physio: string
}

export default function HomeScreen() {
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [modelPhase, setModelPhase] = useState('Starting…')

  // Wallet init
  useEffect(() => {
    getOrCreateKeypair().then(setKeypair)
  }, [])

  // Track QVAC model loading
  useEffect(() => {
    const unsub = qvacBridge.onMessage((msg) => {
      if (msg.type === 'status') {
        const pct = msg.percentage != null ? ` ${msg.percentage.toFixed(0)}%` : ''
        setModelPhase(
          msg.phase === 'loading_vision'
            ? `Loading vision model…${pct}`
            : msg.phase
        )
      }
      if (msg.type === 'ready') {
        setModelReady(true)
        setModelPhase('Ready')
      }
    })
    if (qvacBridge.isReady) setModelReady(true)
    return unsub
  }, [])

  const loadPlan = useCallback(async () => {
    if (!keypair) return
    setLoadingPlan(true)
    try {
      // Demo: physio pubkey would come from a QR scan or deep link in production
      const physioPubkey = new PublicKey('11111111111111111111111111111111') // replace with real physio key
      const wallet = makeWalletAdapter(keypair)
      const data = await fetchTreatmentPlan(wallet, physioPubkey, keypair.publicKey)
      setPlan({
        sessionsTotal: data.sessionsTotal,
        sessionsCompleted: data.sessionsCompleted,
        pusdPerSession: data.pusdPerSession.toNumber() / PUSD_DECIMALS,
        planActive: data.planActive,
        physio: data.physio.toBase58(),
      })
    } catch {
      // No plan found for this wallet — normal on first launch
    } finally {
      setLoadingPlan(false)
    }
  }, [keypair])

  useEffect(() => { loadPlan() }, [loadPlan])

  const startExercise = () => {
    if (!modelReady) {
      Alert.alert(
        'Model Loading',
        'The on-device AI is still loading. This only happens once per session.'
      )
      return
    }
    router.push({
      pathname: '/exercise',
      params: plan
        ? {
            sessionNumber: String(plan.sessionsCompleted + 1),
            sessionsTotal: String(plan.sessionsTotal),
            physio: plan.physio,
          }
        : {},
    })
  }

  const address = keypair?.publicKey.toBase58() ?? '…'
  const shortAddress = address !== '…'
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : '…'

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Wallet card */}
      <View style={s.card}>
        <Text style={s.cardLabel}>Your Wallet</Text>
        <Text style={s.address}>{shortAddress}</Text>
        <Text style={s.hint}>Generated on first launch · stored locally</Text>
      </View>

      {/* QVAC status */}
      <View style={[s.card, modelReady ? s.cardGreen : s.cardAmber]}>
        <Text style={s.cardLabel}>On-Device AI (QVAC)</Text>
        <View style={s.row}>
          {!modelReady && <ActivityIndicator size="small" color="#92400e" style={{ marginRight: 8 }} />}
          <Text style={[s.statusText, modelReady ? s.statusGreen : s.statusAmber]}>
            {modelPhase}
          </Text>
        </View>
        <Text style={s.hint}>SmolVLM2-500M — running locally, no data uploaded</Text>
      </View>

      {/* Treatment plan */}
      {loadingPlan ? (
        <ActivityIndicator style={{ marginVertical: 24 }} color="#16a34a" />
      ) : plan ? (
        <View style={s.card}>
          <Text style={s.cardLabel}>Active Treatment Plan</Text>
          <View style={s.progressRow}>
            <Text style={s.big}>{plan.sessionsCompleted}</Text>
            <Text style={s.of}> / {plan.sessionsTotal}</Text>
            <Text style={s.label}> sessions</Text>
          </View>
          <View style={s.progressBar}>
            <View
              style={[
                s.progressFill,
                { width: `${(plan.sessionsCompleted / plan.sessionsTotal) * 100}%` },
              ]}
            />
          </View>
          <Text style={s.hint}>
            ${plan.pusdPerSession.toFixed(2)} PUSD per verified session
          </Text>
        </View>
      ) : (
        <View style={[s.card, s.cardDashed]}>
          <Text style={s.noplan}>No active plan found</Text>
          <Text style={s.hint}>Ask your physiotherapist to create a plan for your wallet.</Text>
        </View>
      )}

      {/* Start exercise button */}
      <TouchableOpacity
        style={[s.button, !modelReady && s.buttonDisabled]}
        onPress={startExercise}
        activeOpacity={0.8}
      >
        <Text style={s.buttonText}>
          {modelReady ? 'Start Exercise Session →' : 'Loading AI…'}
        </Text>
      </TouchableOpacity>

      <Text style={s.footer}>
        All exercise verification happens on your device.{'\n'}
        No video or images are ever uploaded.
      </Text>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 20, gap: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 4,
  },
  cardGreen: { borderColor: '#86efac', backgroundColor: '#f0fdf4' },
  cardAmber: { borderColor: '#fcd34d', backgroundColor: '#fffbeb' },
  cardDashed: { borderStyle: 'dashed' },
  cardLabel: { fontSize: 11, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  address: { fontSize: 15, fontFamily: 'monospace', color: '#111827', marginTop: 2 },
  hint: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  statusText: { fontSize: 15, fontWeight: '600' },
  statusGreen: { color: '#15803d' },
  statusAmber: { color: '#92400e' },
  progressRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 4 },
  big: { fontSize: 36, fontWeight: '800', color: '#111827' },
  of: { fontSize: 24, color: '#6b7280' },
  label: { fontSize: 16, color: '#6b7280' },
  progressBar: {
    height: 8, borderRadius: 4, backgroundColor: '#e5e7eb',
    marginTop: 8, marginBottom: 4, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#16a34a', borderRadius: 4 },
  noplan: { fontSize: 16, fontWeight: '600', color: '#374151', textAlign: 'center', marginVertical: 8 },
  button: {
    backgroundColor: '#16a34a', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 8,
  },
  buttonDisabled: { backgroundColor: '#86efac' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  footer: { fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8, lineHeight: 18 },
})
