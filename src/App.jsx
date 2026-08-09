import { useState } from "react";
import TitleScreen from "./TitleScreen.jsx";
import HockeyBattle from "./HockeyBattle.jsx";

export default function App() {
  const [started, setStarted] = useState(false);

  if (!started) {
    return <TitleScreen onStart={() => setStarted(true)} />;
  }

  return <HockeyBattle />;
}
