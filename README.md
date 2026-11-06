# Superhero Add-on (Minecraft Bedrock 1.21.130+)

Add-on de superhéroes de mundo abierto: súper velocidad, vuelo, manipulación del tiempo, Modo Ira, karma, ciudad procedural de 2048x2048, trajes (Urbano, Táctico, Bio-Armadura), el Amigo (Operador de Radio), el Villano Eléctrico, drones y Súper Soldados de Vektor Corp.

## Estructura
- `Superhero_BP/` Behavior Pack: scripts (`scripts/`), entidades, ítems, recetas, loot tables.
- `Superhero_RP/` Resource Pack: modelos, texturas, animaciones, attachables y textos `es_ES.lang`.

## Instalación
Comprime las dos carpetas en un `.zip` y renómbralo a `.mcaddon`, o importa cada carpeta como pack. Crea un mundo **Plano (Superflat)** con ambos packs y trampas activadas.

## Comandos de prueba
`/scriptevent sh:powers on`, `sh:rage`, `sh:karma -30`, `sh:unlock flight`, `sh:bio unlock`, `sh:city goto hq|lab|amigo|bank|fortress|lighthouse|shore|plaza`, `sh:city status`.

## Notas
- Script API `@minecraft/server` 2.0.0. Textos en español.
- Los archivos JSON están minificados en este repositorio; los PNG se suben en commits aparte.
