"""Normalise Tripo crane → game/public/assets/env/env_crane.glb (14 m tall, feet pivot)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import tripo_static_normalize as t
t.run("env_crane", "assets/source/tripo/env_crane/tripo-out/stylized-cartoon-rusted-orange-i-1b363a02/model.glb", "env", "mat_crane_rust", target_h=14.0)
