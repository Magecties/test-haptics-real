import { useEffect, useRef, useState } from 'react'

type Status = 'idle' | 'arming' | 'armed' | 'alarming' | 'stopped'

export default function App() {
  const [thresholdDb, setThresholdDb] = useState(-25)
  const [holdSeconds, setHoldSeconds] = useState(2)
  const [status, setStatus] = useState<Status>('idle')
  const [currentDb, setCurrentDb] = useState(-100)
  const [holdProgress, setHoldProgress] = useState(0) // 0..1
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

  async function arm() {
    setError(null)
    setStatus('arming')
    try {
      await setupMic()
      startMeterLoop()
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
  const thresholdPct = Math.max(0, Math.min(100, ((thresholdDb + 60) / 60) * 100))
  const aboveThreshold = currentDb >= thresholdDb

  return (
    <div className="app">
      <h1>Yell To Stop</h1>

      <div className="row">
        <label>Threshold (dBFS)</label>
        <input
          type="number"
          value={thresholdDb}
          step={1}
          min={-60}
          max={0}
          onChange={(e) => setThresholdDb(Number(e.target.value))}
          disabled={status !== 'idle' && status !== 'stopped'}
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
          disabled={status !== 'idle' && status !== 'stopped'}
        />
      </div>
      <p className="hint">
        You must yell continuously above the threshold for the full hold time.
        Try -25 dBFS for 2s. Lower number = quieter.
      </p>

      <div className="meter" aria-label="loudness meter">
        <div className="bar" style={{ width: `${barPct}%` }} />
        <div className="threshold" style={{ left: `${thresholdPct}%` }} />
      </div>
      <div className="stat">
        Now: {currentDb.toFixed(1)} dBFS &nbsp;·&nbsp; Threshold: {thresholdDb} dBFS
      </div>

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

      {status === 'idle' || status === 'stopped' ? (
        <button className="start" onClick={arm}>Arm alarm</button>
      ) : (
        <button className="stop" onClick={cancel}>Cancel</button>
      )}

      {error && <div style={{ color: '#fca5a5' }}>⚠ {error}</div>}
    </div>
  )
}
