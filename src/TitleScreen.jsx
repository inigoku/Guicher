import titleArtUrl from "./assets/title-art.webp";
import "./TitleScreen.css";

export default function TitleScreen({ onStart }) {
  return (
    <div
      id="titleScreen"
      style={{ backgroundImage: `url(${titleArtUrl})` }}
      onClick={onStart}
      onTouchEnd={(e) => {
        e.preventDefault();
        onStart();
      }}
    >
      <div id="titleScreenOverlay">
        <h1 id="titleScreenTitle">El Güicher</h1>
        <p id="titleScreenPrompt">Toca para empezar</p>
      </div>
    </div>
  );
}
