import { useEffect, useRef, useState } from 'react'

type Status = 'idle' | 'testing' | 'arming' | 'armed' | 'alarming' | 'stopped'

export default function App() {
  const [thresholdDb, setThresholdDb] = useState(-25)
  const [holdSeconds, setHoldSeconds] = useState(2)
  const [status, setStatus] = useState<Status>('idle')
  const [currentDb, setCurrentDb] = useState(-100)
  const [peakDb, setPeakDb] = useState(-100)
  const [holdProgress, setHoldProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const alarmOscRef = useRef<{ stop: () => void } | null>(null)

  const statusRef = useRef<Status>('idle')
  const thresholdDbRef = useRef(thresholdDb)
  const holdSecondsRef = useRef(holdSeconds)
  const loudSinceRef = useRef<number | null>(null)
  const peakRef = useRef(-100)

  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => { thresholdDbRef.current = thresholdDb }, [thresholdDb])
  useEffect(() => { holdSecondsRef.current = holdSeconds }, [holdSeconds])

  function startAlarmSound() {
    const ctx = audioCtxRef.current
    if (!ctx || alarmOscRef.current) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 880
    gain.gain.value = 0.15
    osc.connect(gain).connect(ctx.destination)
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.frequency.value = 4
    lfoGain.gain.value = 200
    lfo.connect(lfoGain).connect(osc.frequency)
    osc.start()
    lfo.start()
    alarmOscRef.current = {
      stop: () => { try { osc.stop(); lfo.stop() } catch { /* noop */ } },
    }
    if ('vibrate' in navigator) navigator.vibrate?.([400, 200, 400, 200, 400])
  }

  function stopAlarmSound() {
    alarmOscRef.current?.stop()
    alarmOscRef.current = null
    if ('vibrate' in navigator) navigator.vibrate?.(0)
  }

  async function setupMic() {
    if (streamRef.current) return // already running
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    streamRef.current = stream
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    analyserRef.current = analyser
    startMeterLoop()
  }

  function startMeterLoop() {
    const analyser = analyserRef.current!
    const buf = new Float32Array(analyser.fftSize)
    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      const db = rms > 0 ? 20 * Math.log10(rms) : -100
      setCurrentDb(db)

      if (db > peakRef.current) {
        peakRef.current = db
        setPeakDb(db)
      }

      const now = performance.now()
      const aboveThreshold = db >= thresholdDbRef.current

      if (statusRef.current === 'alarming') {
        if (aboveThreshold) {
          if (loudSinceRef.current === null) loudSinceRef.current = now
          const heldMs = now - loudSinceRef.current
          const needed = holdSecondsRef.current * 1000
          setHoldProgress(Math.min(1, heldMs / needed))
          if (heldMs >= needed) {
            succeed()
            return
          }
        } else {
          loudSinceRef.current = null
          setHoldProgress(0)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  async function startTest() {
    setError(null)
    try {
      peakRef.current = -100
      setPeakDb(-100)
      await setupMic()
      setStatus('testing')
    } catch (e) {
      setError((e as Error).message)
      teardown()
    }
  }

  function stopTest() {
    teardown()
    setStatus('idle')
  }

  function resetPeak() {
    peakRef.current = -100
    setPeakDb(-100)
  }

  async function arm() {
    setError(null)
    setStatus('arming')
    try {
      await setupMic()
      setStatus('armed')
      setTimeout(() => {
        if (statusRef.current === 'armed') {
          setStatus('alarming')
          loudSinceRef.current = null
          setHoldProgress(0)
          startAlarmSound()
        }
      }, 3000)
    } catch (e) {
      setError((e as Error).message)
      setStatus('idle')
      teardown()
    }
  }

  function succeed() {
    stopAlarmSound()
    setStatus('stopped')
    teardown()
  }

  function cancel() {
    stopAlarmSound()
    setStatus('idle')
    teardown()
  }

  function teardown() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    analyserRef.current = null
    loudSinceRef.current = null
  }

  useEffect(() => () => teardown(), [])

  const barPct = Math.max(0, Math.min(100, ((currentDb + 60) / 60) * 100))
  const peakPct = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100))
  const thresholdPct = Math.max(0, Math.min(100, ((thresholdDb + 60) / 60) * 100))
  const aboveThreshold = currentDb >= thresholdDb
  const micActive = status === 'testing' || status === 'armed' || status === 'alarming' || status === 'arming'
  const settingsLocked = status !== 'idle' && status !== 'stopped' && status !== 'testing'

  return (
    <div className="app">
      <h1>Yell To Stop</h1>

      <div className="readout">
        <div className="readout-big">{currentDb.toFixed(1)}<span className="readout-unit"> dBFS</span></div>
        <div className="readout-sub">
          peak {peakDb.toFixed(1)} &nbsp;·&nbsp; threshold {thresholdDb}
          {aboveThreshold && micActive && <span className="badge"> ABOVE</span>}
        </div>
      </div>

      <div className="meter" aria-label="loudness meter">
        <div className="bar" style={{ width: `${barPct}%` }} />
        <div className="peak-marker" style={{ left: `${peakPct}%` }} />
        <div className="threshold" style={{ left: `${thresholdPct}%` }} />
      </div>

      {!micActive && (
        <button className="start" onClick={startTest}>🎤 Test microphone</button>
      )}
      {status === 'testing' && (
        <div className="row">
          <button className="stop" onClick={stopTest} style={{ flex: 1 }}>Stop test</button>
          <button className="start" onClick={resetPeak} style={{ flex: 1 }}>Reset peak</button>
        </div>
      )}

      <div className="row">
        <label>Threshold (dBFS)</label>
        <input
          type="number"
          value={thresholdDb}
          step={1}
          min={-60}
          max={0}
          onChange={(e) => setThresholdDb(Number(e.target.value))}
          disabled={settingsLocked}
        />
      </div>
      <div className="row">
        <label>Hold (seconds)</label>
        <input
          type="number"
          value={holdSeconds}
          step={0.5}
          min={0.5}
          max={10}
          onChange={(e) => setHoldSeconds(Number(e.target.value))}
          disabled={settingsLocked}
        />
      </div>
      <p className="hint">
        dBFS goes from 0 (max) down to negative numbers (quieter). Use Test microphone to find a
        good threshold — yell, watch the peak, set threshold a little below it.
      </p>

      {status === 'alarming' && (
        <>
          <div className="alarm-banner">
            🚨 ALARM! Yell for {holdSeconds}s straight to stop
          </div>
          <div className="meter" aria-label="hold progress">
            <div
              className="bar"
              style={{
                width: `${holdProgress * 100}%`,
                background: aboveThreshold ? '#10b981' : '#6b7280',
              }}
            />
          </div>
          <div className="stat">
            Held: {(holdProgress * holdSeconds).toFixed(1)} / {holdSeconds.toFixed(1)}s
          </div>
        </>
      )}
      {status === 'armed' && (
        <div className="alarm-banner" style={{ background: '#1e3a8a', borderColor: '#3b82f6' }}>
          Armed — alarm fires in 3s…
        </div>
      )}
      {status === 'stopped' && (
        <div className="alarm-banner" style={{ background: '#064e3b', borderColor: '#10b981' }}>
          ✓ You did it. Alarm stopped.
        </div>
      )}

      {(status === 'idle' || status === 'stopped' || status === 'testing') ? (
        <button className="start" onClick={arm}>Arm alarm</button>
      ) : (
        <button className="stop" onClick={cancel}>Cancel</button>
      )}

      {error && <div style={{ color: '#fca5a5' }}>⚠ {error}</div>}
    </div>
  )
}
