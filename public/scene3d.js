import * as THREE from './vendor/three.module.js';

const stage = document.querySelector('.sup-3d-stage');

if (stage) {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPowerDevice = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
    const renderer = new THREE.WebGLRenderer({
        antialias: !lowPowerDevice,
        alpha: true,
        powerPreference: 'low-power'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPowerDevice ? 1 : 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0.2, 9);

    const rig = new THREE.Group();
    scene.add(rig);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(3, 4, 6);
    scene.add(keyLight);

    const fillLight = new THREE.PointLight(0x00a6a6, 3, 12);
    fillLight.position.set(-3.6, -1.2, 4);
    scene.add(fillLight);

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));

    const materials = {
        blue: new THREE.MeshPhysicalMaterial({
            color: 0x1769e0,
            roughness: 0.34,
            metalness: 0.14,
            transmission: 0.12,
            thickness: 0.5
        }),
        cyan: new THREE.MeshPhysicalMaterial({
            color: 0x00a6a6,
            roughness: 0.3,
            metalness: 0.18,
            clearcoat: 0.5
        }),
        amber: new THREE.MeshStandardMaterial({
            color: 0xd98a12,
            roughness: 0.42,
            metalness: 0.22
        }),
        line: new THREE.LineBasicMaterial({
            color: 0x17324f,
            transparent: true,
            opacity: 0.18
        })
    };

    const torus = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.22, 18, 56), materials.blue);
    torus.position.set(-3.2, 1.12, -1.4);
    torus.rotation.set(0.82, 0.2, -0.28);
    rig.add(torus);

    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.72, 0.18, 72, 12), materials.cyan);
    knot.position.set(3.25, -0.76, -0.9);
    knot.rotation.set(0.35, -0.4, 0.2);
    rig.add(knot);

    const prism = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 1), materials.amber);
    prism.position.set(2.9, 2.12, -2.6);
    prism.rotation.set(0.6, 0.52, 0);
    rig.add(prism);

    const small = new THREE.Mesh(new THREE.OctahedronGeometry(0.44, 0), materials.cyan);
    small.position.set(-2.2, -2.05, -0.8);
    rig.add(small);

    const grid = new THREE.GridHelper(9, 18, 0x17324f, 0x17324f);
    grid.material.transparent = true;
    grid.material.opacity = 0.1;
    grid.position.set(0, -2.75, -1.3);
    grid.rotation.x = 0.14;
    rig.add(grid);

    const curvePoints = [
        new THREE.Vector3(-4.8, -1.2, -1.8),
        new THREE.Vector3(-2.2, 1.8, -2.8),
        new THREE.Vector3(1.2, 0.9, -2.1),
        new THREE.Vector3(4.6, 2.4, -3.3)
    ];
    const curve = new THREE.CatmullRomCurve3(curvePoints);
    const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(36)),
        materials.line
    );
    rig.add(line);

    const clock = new THREE.Clock();
    let pointerX = 0;
    let pointerY = 0;

    window.addEventListener('pointermove', (event) => {
        pointerX = (event.clientX / window.innerWidth - 0.5) * 0.4;
        pointerY = (event.clientY / window.innerHeight - 0.5) * 0.28;
    }, { passive: true });

    let resizeTimer = null;
    function syncRendererSize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    }

    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            syncRendererSize();
            render();
        }, 120);
    });

    let frameId = 0;
    let running = false;

    function render() {
        if (document.hidden) {
            running = false;
            frameId = 0;
            return;
        }

        const t = clock.getElapsedTime();
        const motion = prefersReducedMotion ? 0 : t;

        rig.rotation.y = Math.sin(motion * 0.16) * 0.07 + pointerX;
        rig.rotation.x = Math.sin(motion * 0.12) * 0.04 + pointerY;
        torus.rotation.z = -0.28 + motion * 0.12;
        knot.rotation.x = 0.35 + motion * 0.1;
        knot.rotation.y = -0.4 + motion * 0.16;
        prism.rotation.y = 0.52 + motion * 0.13;
        small.position.y = -2.05 + Math.sin(motion * 0.9) * 0.18;

        renderer.render(scene, camera);

        if (!prefersReducedMotion) {
            frameId = requestAnimationFrame(render);
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            running = false;
            if (frameId) cancelAnimationFrame(frameId);
            frameId = 0;
            return;
        }
        if (!running && !prefersReducedMotion) {
            running = true;
            frameId = requestAnimationFrame(render);
        } else {
            render();
        }
    });

    running = true;
    render();
}
