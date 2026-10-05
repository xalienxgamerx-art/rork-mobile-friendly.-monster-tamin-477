import { useEffect } from "react";
import { CreateScreen } from "@/components/game/CreateScreen";
import { GameScreen } from "@/components/game/GameScreen";
import { TitleScreen } from "@/components/game/TitleScreen";
import { playMusic, setScreen, useGame } from "@/game/store";

const Index = () => {
  const { screen, gs } = useGame();

  useEffect(() => {
    const unlock = (): void => {
      playMusic("wilds");
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (screen === "create") return <CreateScreen />;
  if (screen === "game" && gs) return <GameScreen />;
  return <TitleScreen onNewJourney={() => setScreen("create")} />;
};

export default Index;
