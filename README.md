# Escudos de Burgos

Aplicación web para coleccionar y organizar los escudos de los 371 municipios de la provincia de Burgos.

## Arquitectura

- **HTML + CSS + JavaScript modular**: aplicación ligera, sin servidor obligatorio.
- **Leaflet 1.9.4**: navegación y zoom del mapa.
- **INE FeatureServer (DIRCE 2025)**: fuente oficial de los municipios y de la geometría administrativa. La aplicación exige que la consulta provincial devuelva exactamente 371 municipios antes de continuar.
- **Esri World Imagery**: mapa base sin etiquetas de carreteras, comercios ni localidades externas a Burgos.
- **localStorage**: guarda configuración, favoritos y metadatos de la colección.
- **Imágenes en Data URL**: las imágenes subidas quedan incluidas en la persistencia local y en las copias de seguridad.

## Funciones implementadas

- España ↔ Burgos con un clic.
- Zoom desde España hasta nivel municipal.
- Límite provincial real de Burgos con borde negro.
- Carga de los 371 municipios desde una fuente oficial.
- Etiquetas municipales solo dentro de Burgos y solo a partir de un nivel de zoom útil.
- Añadir/cambiar/borrar escudos.
- Escudos arrastrables.
- Cambio de tamaño.
- Bloqueo de posición.
- Favoritos.
- Modo «Solo escudos».
- Buscador y filtros.
- Progreso 0/371.
- Logros de colección.
- Deshacer de acciones principales.
- Exportar/importar copia completa, incluyendo imágenes.
- Modo oscuro/claro.
- Pantalla completa.
- Diseño responsive para móvil y ordenador.

## Ejecutar

Se puede servir como sitio estático. Por ejemplo, con cualquier servidor HTTP local:

```bash
python3 -m http.server 8080
```

Después abrir `http://localhost:8080/` en Chrome.

No se recomienda abrir directamente `index.html` con `file://`, porque el navegador puede bloquear las peticiones de datos del INE.

## Fuentes y atribución

- INE: FeatureServer DIRCE total 2025.
- Esri World Imagery: © Esri, Maxar, Earthstar Geographics y colaboradores.
- La referencia institucional de la Diputación de Burgos confirma que la provincia tiene 371 municipios y dispone de un portal específico de escudos y banderas.

Las imágenes de escudos no se descargan automáticamente de terceros: el usuario puede subir imágenes verificadas manualmente y conservarlas dentro de su propia colección.
