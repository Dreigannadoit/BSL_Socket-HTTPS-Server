import * as CANNON from "cannon-es";

// Creates the physics world plus the named materials/contact materials the
// rest of the game references, and returns a helper for turning a level's
// collision meshes into static trimesh bodies.
export function createPhysicsWorld() {
    const world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0),
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    // Sleeping is enabled world-wide so resting bodies (in practice, that's
    // the pushable movable-object props — see movableObjectSystem.js) stop
    // being fed through narrowphase/solver every frame once they settle.
    // Measured impact: a settled 64-prop stack was costing ~15ms/physics
    // step with sleep disabled (roughly 20x the baseline cost) — sleep
    // drops that back down once nothing is moving. The ball is explicitly
    // exempted from sleep at its own body (ball.js sets allowSleep: false)
    // since its movement is driven by directly setting its velocity from
    // player input rather than physics forces, and a sleeping body won't
    // act on an externally-set velocity until something wakes it — so this
    // flip is safe for the ball specifically, and the only two dynamic
    // (mass > 0) bodies in the whole game are the ball and the movable
    // props, so there's nothing else in the game this can affect.
    world.allowSleep = true;
    world.solver.iterations = 30;
    world.solver.tolerance = 0.00005;

    const floorMaterial = new CANNON.Material("floor");
    const wallMaterial = new CANNON.Material("wall");
    const ballMaterial = new CANNON.Material("ball");

    // Wall bounce
    const wallContact = new CANNON.ContactMaterial(wallMaterial, ballMaterial, {
        friction: 0.55,
        restitution: 0.45,
        contactEquationStiffness: 1e8,
        // Was 3 — that spread the contact's resolution force over ~3x as
        // many substeps as the floor's, which read as the ball "sinking
        // into"/sticking to the wall briefly before separating instead of
        // bouncing off immediately. Matching the floor's value here gives
        // a crisp, same-frame separation on wall impacts too.
        contactEquationRelaxation: 1,
    });
    world.addContactMaterial(wallContact);

    // Floor bounce — reduced restitution vs. walls
    const floorContact = new CANNON.ContactMaterial(floorMaterial, ballMaterial, {
        friction: 0.55,
        restitution: 0.6,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 1,
    });
    world.addContactMaterial(floorContact);

    world.defaultContactMaterial.friction = 0.55;
    world.defaultContactMaterial.restitution = 0.9;

    // Builds a static CANNON.Trimesh body from a rendered mesh's world-space
    // geometry, and picks floor vs. wall material from the node's name.
    function addTrimeshCollider(mesh) {
        mesh.updateWorldMatrix(true, false);
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);

        const posAttr = geometry.attributes.position;
        const vertices = Array.from(posAttr.array);

        let indices;
        if (geometry.index) {
            indices = Array.from(geometry.index.array);
        } else {
            indices = [];
            for (let i = 0; i < posAttr.count; i++) indices.push(i);
        }

        const shape = new CANNON.Trimesh(vertices, indices);

        const isFloor = /floor/i.test(mesh.name);
        const bodyMaterial = isFloor ? floorMaterial : wallMaterial;

        const body = new CANNON.Body({ mass: 0, material: bodyMaterial });
        body.addShape(shape);
        world.addBody(body);
        // Returned so callers that need to toggle this collider later (e.g.
        // GameModeManager removing/re-adding StartTrigger's solid body as
        // the player picks/leaves a game mode) don't have to track it
        // themselves.
        return body;
    }

    // floorMaterial/wallMaterial are returned alongside ballMaterial so
    // other systems (e.g. MovableObjectSystem) can register their own
    // ContactMaterial pairs against the world's existing materials instead
    // of falling back to world.defaultContactMaterial's bouncier tuning.
    return { world, floorMaterial, wallMaterial, ballMaterial, addTrimeshCollider };
}
