import { startGame } from "./modules/main.js";
import { ABOUT_GLB_URL } from "./modules/config.js";

// Same game logic/bootstrap as game.js — only difference is the level GLB
// it loads (about_environment.glb instead of maze_platform_high.glb).
startGame({ levelUrl: ABOUT_GLB_URL });