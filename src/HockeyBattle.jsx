import { useEffect, useRef, useState } from "react";
import { createHockeyEngine } from "./hockeyEngine.js";
import "./HockeyBattle.css";

export default function HockeyBattle() {
  const fieldRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [score, setScore] = useState(0);
  const [grabbing, setGrabbing] = useState(false);
  const [hp, setHp] = useState(3);
  const [turn, setTurn] = useState("player");
  const [gameOver, setGameOver] = useState(null); // null | "win" | "lose"

  useEffect(() => {
    const engine = createHockeyEngine({
      canvas: canvasRef.current,
      field: fieldRef.current,
      onScoreChange: setScore,
      onGrabChange: setGrabbing,
      onHpChange: setHp,
      onTurnChange: setTurn,
      onGameOver: setGameOver,
    });
    engineRef.current = engine;

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const hint =
    gameOver === "win"
      ? "¡Ganaste! Todos los enemigos fueron eliminados."
      : gameOver === "lose"
      ? "Perdiste. Tu personaje fue destruido."
      : turn === "player"
      ? "Arrastra tu disco (naranja) para agarrarlo y suéltalo para lanzarlo."
      : "Turno de los enemigos...";

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
            <div id="statusBlock">
              <span id="hp">{"❤️".repeat(Math.max(0, hp))}</span>
              <span className={`turnBadge ${turn}`}>
                {turn === "player" ? "Tu turno" : "Turno enemigo"}
              </span>
            </div>
            <button id="resetBtn" onClick={() => engineRef.current?.reset()}>
              Reiniciar
            </button>
          </div>
          <p id="hint">{hint}</p>
        </div>

        {gameOver && (
          <div id="gameOverOverlay">
            <div id="gameOverCard">
              <p id="gameOverTitle">{gameOver === "win" ? "¡Victoria!" : "Derrota"}</p>
              <button onClick={() => engineRef.current?.reset()}>Jugar de nuevo</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
