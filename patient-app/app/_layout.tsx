import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { qvacBridge } from '../lib/bare-bridge'

export default function RootLayout() {
  useEffect(() => {
    // Boot the QVAC bare worklet on app start.
    // SmolVLM2-500M loads once and stays in memory for the session.
    qvacBridge.start()
    return () => qvacBridge.unload()
  }, [])

  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#16a34a' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'PhysioLoop' }} />
        <Stack.Screen name="exercise" options={{ title: 'Exercise Session' }} />
      </Stack>
      <StatusBar style="light" />
    </>
  )
}
