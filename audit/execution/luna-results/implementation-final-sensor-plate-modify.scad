// Sensor mount plate — millimetres
plate_w = 60;
plate_d = 40;
plate_t = 4;
hole_d  = 3.4;
inset   = 5;
boss_d  = 10;
boss_h  = 6;

difference() {
    cube([plate_w, plate_d, plate_t]);
    for (x = [inset, plate_w - inset])
        for (y = [inset, plate_d - inset])
            translate([x, y, -1]) cylinder(d = hole_d, h = plate_t + 2, $fn = 32);
    translate([plate_w / 2, plate_d / 2, -1]) cylinder(d = hole_d, h = plate_t + 2, $fn = 32);
}
// connector boss
translate([45, 20, plate_t]) cylinder(d = boss_d, h = boss_h, $fn = 48);
