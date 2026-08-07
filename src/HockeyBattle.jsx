import { useEffect, useRef, useState } from "react";
import { createHockeyEngine } from "./hockeyEngine.js";
import "./HockeyBattle.css";

export default function HockeyBattle() {
  const fieldRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [score, setScore] = useState(0);
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const engine = createHockeyEngine({
      canvas: canvasRef.current,
      field: fieldRef.current,
      onScoreChange: setScore,
      onGrabChange: setGrabbing,
    });
    engineRef.current = engine;

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  return (
    <>
      <div id="rotate-overlay">
        <p>📱 Gira tu dispositivo<br />Guicher se juega en modo vertical.</p>
      </div>

      <div id="field" ref={fieldRef}>
        <canvas id="rink" ref={canvasRef} className={grabbing ? "grabbing" : ""} />

        <div id="hud">
          <div id="topBar">
            <div id="titleBlock">
              <span id="title">Guicher</span>
              <span id="score">Rebotes: {score}</span>
            </div>
            <button id="resetBtn" onClick={() => engineRef.current?.reset()}>
              Reiniciar
            </button>
          </div>
          <p id="hint">Arrastra tu disco (naranja) para agarrarlo y suéltalo para lanzarlo.</p>
        </div>
      </div>
    </>
  );
}
